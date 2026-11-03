import http from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_IDENTITY_FALLBACK_FIXTURE === "true";
describe("Full API identity fallback with controlled browser-protocol fixtures", () => {
  const servers: http.Server[] = [];
  const calls = { primary: [] as string[], alternate: [] as string[] };
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
        calls[role].push(body.url);
        const mode = new URL(body.url).searchParams.get("case")!;
        const mismatch = role === "primary" && mode !== "old-document";
        const diagnostics = {
          ownerBootId:
            mode === "wrong-boot" && role === "primary" ? randomUUID() : boot,
          attempts: [
            {
              attempt: 1,
              pageClosed: !(mode === "not-closed" && role === "primary"),
            },
          ],
        };
        if (mismatch) {
          res.statusCode = 500;
          return res.end(
            JSON.stringify({
              errorCode: "WORKFLOW_NAVIGATION_MISMATCH",
              diagnostics,
            }),
          );
        }
        const wrong =
          (role === "primary" && mode === "old-document") ||
          (role === "alternate" && mode === "wrong-alternate");
        return res.end(
          JSON.stringify({
            content: "<main>Recovered original product 42</main>",
            renderedText: "Recovered original product 42",
            pageStatusCode: 200,
            ...(mode === "missing-url"
              ? {}
              : {
                  url: wrong
                    ? body.url.replace("B000000042", "B000000043")
                    : body.url,
                }),
            readiness: { satisfied: true },
            diagnostics,
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
    "recovers only the original product after closed identity failures and never returns an unsafe alternate",
    async () => {
      for (const mode of [
        "error",
        "old-document",
        "wrong-alternate",
        "missing-url",
        "not-closed",
        "wrong-boot",
        "optout",
      ]) {
        const url = `https://www.amazon.com/Product/dp/B000000042?case=${mode}`;
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
              engineFallback: mode !== "optout",
              maxAttempts: 1,
            },
          }),
        });
        const result = await response.json();
        if (mode === "error" || mode === "old-document") {
          expect(response.status).toBe(200);
          expect(result.data.markdown).toContain(
            "Recovered original product 42",
          );
          expect(result.data.metadata.url).toBe(url);
          const fallback =
            result.data.metadata.browser.diagnostics.engineFallback;
          expect(fallback.recovered).toBe(true);
          expect(fallback.attempts).toHaveLength(2);
          expect(fallback.attempts[0].errorCode).toBe(
            "WORKFLOW_NAVIGATION_MISMATCH",
          );
        } else {
          expect(result.success).toBe(false);
          expect(result.code).toBe("WORKFLOW_NAVIGATION_MISMATCH");
          expect(result.data).toBeUndefined();
        }
        expect(calls.primary.slice(before.primary)).toEqual([url]);
        expect(calls.alternate.slice(before.alternate)).toEqual(
          ["not-closed", "wrong-boot", "optout"].includes(mode) ? [] : [url],
        );
      }
    },
    scrapeTimeout,
  );
});
