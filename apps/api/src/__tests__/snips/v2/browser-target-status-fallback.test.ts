import http from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_TARGET_STATUS_FALLBACK_FIXTURE === "true";
describe("Full API target-status fallback with controlled browser-protocol fixtures", () => {
  const servers: http.Server[] = [];
  const calls = { primary: [] as any[], alternate: [] as any[] };
  beforeAll(async () => {
    if (!enabled) return;
    for (const role of ["primary", "alternate"] as const) {
      const base = new URL(
        role === "primary"
          ? config.LOCAL_BROWSER_OWNER_URLS!
          : config.LOCAL_BROWSER_FALLBACK_OWNER_URLS!,
      );
      expect(base.hostname).toBe("127.0.0.1");
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
        const diagnostics = {
          ownerBootId:
            role === "primary" && mode === "wrong-boot" ? randomUUID() : boot,
          attempts: [
            {
              attempt: 1,
              pageClosed: !(role === "primary" && mode === "not-closed"),
            },
          ],
        };
        if (role === "primary" && mode === "service-400") {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({
              errorCode: "INVALID_OPTIONS",
              error: "Fixture browser request rejected",
              diagnostics,
            }),
          );
        }
        const status =
          role === "primary" || mode === "failed-alternate" ? 400 : 200;
        return res.end(
          JSON.stringify({
            content:
              status === 200
                ? "<main>Original public record 42</main>"
                : "<main>Bad Request</main>",
            renderedText:
              status === 200 ? "Original public record 42" : "Bad Request",
            pageStatusCode: status,
            url: body.url,
            readiness: { satisfied: true },
            diagnostics,
            ...(status === 400 ? { pageError: "Bad Request" } : {}),
          }),
        );
      });
      servers.push(server);
      await new Promise<void>(resolve =>
        server.listen(Number(base.port), "127.0.0.1", resolve),
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
  itIf(enabled)(
    "recovers a completed target HTTP 400 but preserves opt-out, uncertain cleanup and browser validation failures",
    async () => {
      for (const mode of [
        "recover-400",
        "optout",
        "not-closed",
        "wrong-boot",
        "service-400",
        "failed-alternate",
      ]) {
        const url = `https://example.com/public-record?case=${mode}`;
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
            url,
            formats: ["rawHtml", "markdown"],
            waitFor: 0,
            maxAge: 0,
            storeInCache: false,
            timeout: scrapeTimeout,
            browserControls: {
              workflow: "auto",
              maxAttempts: 1,
              engineFallback: mode !== "optout",
            },
          }),
        });
        const result = await response.json();
        if (mode === "recover-400") {
          expect(response.status).toBe(200);
          expect(result.data.metadata.statusCode).toBe(200);
          expect(result.data.markdown).toContain("Original public record 42");
          const fallback =
            result.data.metadata.browser.diagnostics.engineFallback;
          expect(fallback.recovered).toBe(true);
          expect(fallback.attempts).toHaveLength(2);
          expect(fallback.attempts[0].pageStatusCode).toBe(400);
        } else if (mode === "service-400") {
          expect(result.success).toBe(false);
          expect(result.code).toBe("INVALID_OPTIONS");
          expect(result.data).toBeUndefined();
        } else {
          expect(result.data.metadata.statusCode).toBe(400);
          expect(result.data.rawHtml).not.toContain(
            "Original public record 42",
          );
          if (mode === "failed-alternate") {
            const fallback =
              result.data.metadata.browser.diagnostics.engineFallback;
            expect(fallback.attempted).toBe(true);
            expect(fallback.recovered).toBe(false);
            expect(fallback.usedSecondary).toBe(false);
          }
        }
        expect(
          calls.primary.slice(before.primary).map(body => body.url),
        ).toEqual([url]);
        const alternates = calls.alternate.slice(before.alternate);
        expect(alternates.map(body => body.url)).toEqual(
          ["recover-400", "failed-alternate"].includes(mode) ? [url] : [],
        );
        for (const body of alternates) expect(body.max_attempts).toBe(1);
      }
    },
    scrapeTimeout,
  );
});
