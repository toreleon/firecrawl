import http from "node:http";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_PRODUCT_DETAILS_API === "true";
describe("Full API optional product-details workflow", () => {
  const port = Number(process.env.TEST_PRODUCT_DETAILS_FIXTURE_PORT ?? 33397);
  const origin = `http://owned.canadagoose.com:${port}`;
  const calls = { webkit: 0, firefox: 0 };
  let fixture: http.Server | undefined;
  beforeAll(async () => {
    if (!enabled) return;
    for (const [base, engine] of [
      [config.LOCAL_BROWSER_OWNER_URLS, "webkit"],
      [config.LOCAL_BROWSER_FALLBACK_OWNER_URLS, "camoufox"],
    ]) {
      expect(base!.split(",")).toHaveLength(1);
      const response = await fetch(base! + "/health", {
        headers: {
          authorization: `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}`,
        },
      });
      expect((await response.json()).browserEngine).toBe(engine);
    }
    fixture = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.statusCode = 404;
        return res.end();
      }
      if (/Firefox\//.test(req.headers["user-agent"] ?? "")) calls.firefox++;
      else calls.webkit++;
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>Owned product 42</title><main>Original public product 42</main>
        <button type="button" aria-expanded="false" aria-controls="details"
          style="${req.url === "/happy" ? "position:relative;" : "position:fixed;left:-1000px;top:10px;"}width:180px;height:40px"
          onclick="document.querySelector('#click-count').textContent=String(Number(document.querySelector('#click-count').textContent)+1);this.setAttribute('aria-expanded','true');document.querySelector('#details').hidden=false">Product Details</button>
        <section id="details" hidden>Expanded public details 42</section><output id="click-count">0</output>`);
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
  const request = async (path: string, required = false) => {
    const response = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: origin + path,
        formats: ["rawHtml", "markdown"],
        timeout: 30000,
        browserControls: {
          workflow: "auto",
          engineFallback: true,
          ...(required
            ? {
                readiness: {
                  text: "Expanded public details 42",
                  timeoutMs: 300,
                },
              }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(scrapeTimeout),
    });
    return { status: response.status, body: await response.json() };
  };
  itIf(enabled)(
    "expands an actionable control once and forwards confirmed workflow metadata",
    async () => {
      const before = { ...calls };
      const result = await request("/happy");
      expect(result.status).toBe(200);
      expect(result.body.data.markdown).toContain("Expanded public details 42");
      expect(result.body.data.rawHtml).toContain(
        '<output id="click-count">1</output>',
      );
      const browser = result.body.data.metadata.browser;
      expect(
        browser.interaction.workflow.observations.productDetails,
      ).toMatchObject({
        outcome: "expanded",
        clickAttempted: true,
        clickCompleted: true,
      });
      expect(browser.diagnostics.engineFallback.attempted).toBe(false);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
    },
  );
  itIf(enabled)(
    "preserves usable content after an optional native timeout without forcing or repeating the click",
    async () => {
      const before = { ...calls };
      const result = await request("/clipped");
      expect(result.status).toBe(200);
      expect(result.body.data.markdown).toContain("Original public product 42");
      // HTML-to-Markdown conversion can include hidden markup. Expansion is
      // established by DOM state and readiness, not a Markdown substring.
      expect(result.body.data.rawHtml).toMatch(
        /<section id="details" hidden(?:="")?>/,
      );
      expect(result.body.data.rawHtml).toContain(
        '<output id="click-count">0</output>',
      );
      const browser = result.body.data.metadata.browser;
      expect(browser.readiness.satisfied).toBe(true);
      expect(
        browser.interaction.workflow.observations.productDetails,
      ).toMatchObject({
        outcome: "unresolved",
        reason: "action_timeout",
        clickAttempted: true,
        clickCompleted: false,
      });
      expect(browser.diagnostics.engineFallback.attempted).toBe(false);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
    },
  );
  itIf(enabled)(
    "keeps explicitly required hidden content unresolved after one alternate",
    async () => {
      const before = { ...calls };
      const result = await request("/required", true);
      expect(result.status).toBe(200);
      // HTML-to-Markdown conversion can include hidden markup. Expansion is
      // established by DOM state and readiness, not a Markdown substring.
      expect(result.body.data.rawHtml).toMatch(
        /<section id="details" hidden(?:="")?>/,
      );
      expect(result.body.data.rawHtml).toContain(
        '<output id="click-count">0</output>',
      );
      const browser = result.body.data.metadata.browser;
      expect(browser.readiness.satisfied).toBe(false);
      expect(browser.interaction.workflow.steps).toContainEqual({
        type: "product-details",
        outcome: "unresolved",
      });
      expect(browser.diagnostics.engineFallback.recovered).toBe(false);
      expect(browser.diagnostics.engineFallback.attempts).toHaveLength(2);
      expect(
        browser.diagnostics.engineFallback.attempts.every(
          (attempt: any) => attempt.pageClosed && attempt.contextClosed,
        ),
      ).toBe(true);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox - before.firefox).toBe(1);
    },
  );
});
