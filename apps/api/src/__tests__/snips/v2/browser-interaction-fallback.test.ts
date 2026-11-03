import http from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_INTERACTION_FALLBACK_FIXTURE === "true";
const blockedStates = [
  "HUMAN_REQUIRED",
  "VERIFICATION_REQUIRED",
  "AUTH_REQUIRED",
  "REGION_UNAVAILABLE",
  "COUNTRY_SELECTION",
  "ACCESS_DENIED",
  "CONTENT_NOT_READY",
  "UNKNOWN_FUTURE_STATE",
];

describe("Full API interaction-state fallback with controlled browser-protocol fixtures", () => {
  const servers: http.Server[] = [];
  const calls = { primary: [] as any[], alternate: [] as any[] };
  beforeAll(async () => {
    if (!enabled) return;
    for (const role of ["primary", "alternate"] as const) {
      const address = new URL(
        role === "primary"
          ? config.LOCAL_BROWSER_OWNER_URLS!
          : config.LOCAL_BROWSER_FALLBACK_OWNER_URLS!,
      );
      expect(address.hostname).toBe("127.0.0.1");
      const boot = randomUUID();
      const server = http.createServer(async (req, res) => {
        res.setHeader("content-type", "application/json");
        if (
          config.BROWSER_SERVICE_AUTH_TOKEN &&
          req.headers.authorization !==
            `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}`
        ) {
          res.statusCode = 401;
          return res.end("{}");
        }
        if (req.url === "/health")
          return res.end(
            JSON.stringify({
              status: "healthy",
              browserEngine: role === "primary" ? "rebrowser" : "camoufox",
              ownerBootId: boot,
              capabilities: { version: 1, actions: [] },
            }),
          );
        let bytes = "";
        for await (const chunk of req) bytes += chunk;
        const body = JSON.parse(bytes);
        calls[role].push(body);
        const mode = new URL(body.url).searchParams.get("case")!;
        const state =
          role === "primary"
            ? mode === "recover-verification"
              ? "VERIFICATION_REQUIRED"
              : "HUMAN_REQUIRED"
            : mode.startsWith("alternate-")
              ? mode.slice("alternate-".length)
              : "CONTENT_READY";
        return res.end(
          JSON.stringify({
            content:
              role === "primary"
                ? "<main>Security verification remains unresolved</main>"
                : "<main>Original public record 42</main>",
            renderedText:
              role === "primary"
                ? "Security verification remains unresolved"
                : "Original public record 42",
            url: body.url,
            pageStatusCode: 200,
            readiness: { satisfied: true },
            ...(role === "alternate" && mode === "legacy-no-state"
              ? {}
              : { interaction: { state } }),
            diagnostics: {
              ownerBootId:
                role === "primary" && mode === "wrong-boot"
                  ? randomUUID()
                  : boot,
              attempts: [
                {
                  attempt: 1,
                  pageClosed: !(role === "primary" && mode === "not-closed"),
                },
              ],
            },
            // Deliberately omit botDetection/pageError/errorCode: current owners
            // can identify the workflow gate without a legacy vendor signature.
          }),
        );
      });
      servers.push(server);
      await new Promise<void>(resolve =>
        server.listen(Number(address.port), "127.0.0.1", resolve),
      );
    }
  });
  afterAll(async () => {
    await Promise.all(
      servers.map(
        server =>
          new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });
  const scrape = async (mode: string) => {
    const before = {
      primary: calls.primary.length,
      alternate: calls.alternate.length,
    };
    const response = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.TEST_API_KEY ?? "test"}`,
      },
      body: JSON.stringify({
        url: `https://example.com/public-record?case=${mode}`,
        formats: ["rawHtml", "markdown"],
        maxAge: 0,
        storeInCache: false,
        waitFor: 0,
        timeout: scrapeTimeout,
        browserControls: {
          workflow: "auto",
          maxAttempts: 1,
          engineFallback: mode !== "optout",
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(calls.primary.slice(before.primary)).toHaveLength(1);
    const alternates = calls.alternate.slice(before.alternate);
    for (const body of alternates) expect(body.max_attempts).toBe(1);
    return { result, alternates };
  };
  for (const mode of [
    "recover-human",
    "recover-verification",
    "legacy-no-state",
  ])
    itIf(enabled)(
      `recovers ${mode} under the original stateless request`,
      async () => {
        const { result, alternates } = await scrape(mode);
        expect(result.data.markdown).toContain("Original public record 42");
        expect(alternates).toHaveLength(1);
        const fallback =
          result.data.metadata.browser.diagnostics.engineFallback;
        expect(fallback.recovered).toBe(true);
        expect(fallback.attempts).toHaveLength(2);
        expect(fallback.attempts.every((a: any) => a.pageClosed)).toBe(true);
      },
      scrapeTimeout,
    );
  for (const state of blockedStates)
    itIf(enabled)(
      `does not promote alternate ${state} as recovered content`,
      async () => {
        const { result, alternates } = await scrape("alternate-" + state);
        expect(alternates).toHaveLength(1);
        expect(result.data.rawHtml).toContain(
          "Security verification remains unresolved",
        );
        expect(result.data.rawHtml).not.toContain("Original public record 42");
        const fallback =
          result.data.metadata.browser.diagnostics.engineFallback;
        expect(fallback.attempted).toBe(true);
        expect(fallback.recovered).toBe(false);
        expect(fallback.usedSecondary).toBe(false);
      },
      scrapeTimeout,
    );
  for (const mode of ["optout", "not-closed", "wrong-boot"])
    itIf(enabled)(
      `keeps ${mode} terminal without another owner`,
      async () => {
        const { result, alternates } = await scrape(mode);
        expect(alternates).toHaveLength(0);
        expect(result.data.rawHtml).not.toContain("Original public record 42");
      },
      scrapeTimeout,
    );
});
