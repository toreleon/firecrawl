import http from "node:http";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled = TEST_SELF_HOST && process.env.TEST_WEBKIT_API === "true";
describe("Full API with an opt-in contained WebKit alternate", () => {
  let fixture: http.Server | undefined;
  const calls: { path: string; safari: boolean }[] = [];
  const fixturePort = Number(process.env.TEST_WEBKIT_FIXTURE_PORT ?? 33391);
  const origin = `http://host.docker.internal:${fixturePort}`;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = http.createServer((req, res) => {
      const safari =
        /AppleWebKit\//.test(req.headers["user-agent"] ?? "") &&
        !/Chrome\/|Firefox\//.test(req.headers["user-agent"] ?? "");
      calls.push({ path: req.url ?? "/", safari });
      res.setHeader("content-type", "text/html");
      if (req.url === "/public-record" && safari)
        return res.end(
          '<main id="record" hidden>Owned API WebKit record 42</main><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.querySelector(\'#record\').hidden=false;document.querySelector(\'#onetrust-banner-sdk\').remove()">Reject All</button></div>',
        );
      res.statusCode = 403;
      res.end(
        '<title>Just a moment...</title><main>Checking your browser</main><div id="cf-chl-widget"></div>',
      );
    });
    await new Promise<void>(resolve =>
      fixture!.listen(fixturePort, "0.0.0.0", resolve),
    );
    const token = config.BROWSER_SERVICE_AUTH_TOKEN;
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    const alternate = config.LOCAL_BROWSER_FALLBACK_OWNER_URLS!.split(",");
    expect(alternate).toHaveLength(1);
    const health = await (
      await fetch(alternate[0] + "/health", { headers })
    ).json();
    expect(health.browserEngine).toBe("webkit");
  });
  afterAll(async () => {
    if (!fixture) return;
    await new Promise<void>(resolve => {
      fixture!.close(() => resolve());
      fixture!.closeAllConnections();
    });
  });

  itIf(enabled)(
    "recovers a closed primary denial on WebKit and forwards consent/readiness controls",
    async () => {
      const response = await fetch(TEST_API_URL + "/v2/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: origin + "/public-record",
          formats: ["rawHtml", "markdown"],
          timeout: 30000,
          browserControls: {
            engineFallback: true,
            consent: "rejectNonEssential",
            workflow: "auto",
            readiness: { text: "Owned API WebKit record 42", timeoutMs: 3000 },
            navigationTimeout: 8000,
          },
        }),
        signal: AbortSignal.timeout(scrapeTimeout),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.rawHtml).toContain("Owned API WebKit record 42");
      expect(body.data.markdown).toContain("Owned API WebKit record 42");
      expect(body.data.metadata.browser.interaction.state).toBe(
        "CONTENT_READY",
      );
      const fallback = body.data.metadata.browser.diagnostics.engineFallback;
      expect(fallback.recovered).toBe(true);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[1].engine).toBe("webkit");
      expect(
        calls.filter(c => c.path === "/public-record" && c.safari),
      ).toHaveLength(1);
    },
  );
  itIf(enabled)(
    "preserves unresolved denial and does not dispatch WebKit when fallback is omitted",
    async () => {
      for (const fallback of [false, true]) {
        const before = calls.filter(c => c.safari).length;
        const response = await fetch(TEST_API_URL + "/v2/scrape", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: origin + "/denied",
            formats: ["rawHtml"],
            timeout: 30000,
            browserControls: {
              workflow: "auto",
              ...(fallback ? { engineFallback: true } : {}),
            },
          }),
          signal: AbortSignal.timeout(scrapeTimeout),
        });
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.data.metadata.statusCode).toBe(403);
        expect(body.data.metadata.browser.interaction.state).not.toBe(
          "CONTENT_READY",
        );
        expect(calls.filter(c => c.safari).length - before).toBe(
          fallback ? 1 : 0,
        );
        if (fallback)
          expect(
            body.data.metadata.browser.diagnostics.engineFallback.recovered,
          ).toBe(false);
      }
    },
  );
});
