import http from "node:http";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_ALIBABA_INTERCEPTION_API === "true";
describe("Full API HTTP 200 Alibaba interception handling", () => {
  const port = Number(process.env.TEST_ALIBABA_FIXTURE_PORT ?? 33395);
  const origin = `http://host.docker.internal:${port}`;
  const calls = { webkit: 0, firefox: 0, submissions: 0 };
  let fixture: http.Server | undefined;
  const gate = `<!doctype html><html><head><title>Captcha Interception</title>
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'">
    <style>/*${"x".repeat(90000)}*/</style>
    <script src="https://g.alicdn.com/AWSC/CAPTCHA/0.0.1/awsc.js"></script>
    <script src="https://g.alicdn.com/bsop-static/sufei-punish/0.1.130/build/punishpage.min.js"></script>
    </head><body><div id="baxia-punish"><p>Sorry, we have detected unusual traffic from your network.</p>
    <form id="nc-verify-form" action="/product/_____tmd_____/verify/"><button>Verify</button></form></div></body></html>`;
  beforeAll(async () => {
    if (!enabled) return;
    const headers = {
      authorization: `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}`,
    };
    for (const [base, engine] of [
      [config.LOCAL_BROWSER_OWNER_URLS, "webkit"],
      [config.LOCAL_BROWSER_FALLBACK_OWNER_URLS, "camoufox"],
    ]) {
      expect(base!.split(",")).toHaveLength(1);
      expect(
        (await (await fetch(base! + "/health", { headers })).json())
          .browserEngine,
      ).toBe(engine);
    }
    fixture = http.createServer((req, res) => {
      if (req.url?.includes("/_____tmd_____/verify/")) calls.submissions++;
      if (req.url === "/favicon.ico") {
        res.statusCode = 404;
        return res.end();
      }
      const firefox = /Firefox\//.test(req.headers["user-agent"] ?? "");
      if (firefox) calls.firefox++;
      else calls.webkit++;
      res.setHeader("content-type", "text/html");
      const ordinary =
        "<title>Original product</title><main>Original public record 42</main>";
      res.end(
        req.url === "/ordinary" || (firefox && req.url === "/recover")
          ? ordinary
          : gate,
      );
    });
    await new Promise<void>(resolve =>
      fixture!.listen(port, "0.0.0.0", resolve),
    );
  });
  afterAll(async () => {
    if (fixture)
      await new Promise<void>(resolve => {
        fixture!.close(() => resolve());
        fixture!.closeAllConnections();
      });
  });
  const request = async (path: string, fallback = true) => {
    const response = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: origin + path,
        formats: ["rawHtml", "markdown"],
        timeout: 30000,
        browserControls: {
          workflow: "auto",
          ...(fallback ? { engineFallback: true } : {}),
        },
      }),
      signal: AbortSignal.timeout(scrapeTimeout),
    });
    return { status: response.status, body: await response.json() };
  };
  itIf(enabled)(
    "recovers an HTTP 200 interception once on a distinct engine without submitting verification",
    async () => {
      const before = { ...calls };
      const result = await request("/recover");
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data.markdown).toContain("Original public record 42");
      const fallback =
        result.body.data.metadata.browser.diagnostics.engineFallback;
      expect(fallback.recovered).toBe(true);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[0]).toMatchObject({
        engine: "webkit",
        pageClosed: true,
        errorCode: "CONTENT_NOT_READY",
      });
      expect(fallback.attempts[1]).toMatchObject({
        engine: "camoufox",
        pageClosed: true,
      });
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox - before.firefox).toBe(1);
      expect(calls.submissions).toBe(0);
    },
  );
  itIf(enabled)(
    "keeps an opt-out or still-challenged alternate unresolved and does not replay verification",
    async () => {
      let before = { ...calls };
      const optout = await request("/recover", false);
      expect(optout.status).toBe(200);
      expect(optout.body.data.metadata.browser.interaction.state).toBe(
        "HUMAN_REQUIRED",
      );
      expect(optout.body.data.metadata.browser.readiness.satisfied).toBe(false);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
      before = { ...calls };
      const unresolved = await request("/unresolved");
      expect(unresolved.body.data.metadata.browser.interaction.state).toBe(
        "HUMAN_REQUIRED",
      );
      expect(
        unresolved.body.data.metadata.browser.diagnostics.engineFallback
          .recovered,
      ).toBe(false);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox - before.firefox).toBe(1);
      expect(calls.submissions).toBe(0);
    },
  );
  itIf(enabled)(
    "leaves ordinary product content ready without dispatching an alternate",
    async () => {
      const before = { ...calls };
      const result = await request("/ordinary");
      expect(result.body.data.markdown).toContain("Original public record 42");
      expect(result.body.data.metadata.browser.interaction.state).toBe(
        "CONTENT_READY",
      );
      expect(
        result.body.data.metadata.browser.diagnostics.engineFallback.attempted,
      ).toBe(false);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
      expect(calls.submissions).toBe(0);
    },
  );
});
