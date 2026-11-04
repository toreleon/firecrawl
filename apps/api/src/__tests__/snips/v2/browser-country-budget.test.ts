import http from "node:http";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_COUNTRY_BUDGET_API === "true";
describe("Full API country-workflow budgets", () => {
  const port = Number(process.env.TEST_COUNTRY_BUDGET_FIXTURE_PORT ?? 33398);
  const origin = `http://www.bestbuy.com:${port}`;
  const calls = { webkit: 0, firefox: 0, wrong: 0 };
  let fixture: http.Server | undefined;
  beforeAll(async () => {
    if (!enabled) return;
    for (const [base, engine] of [
      [config.LOCAL_BROWSER_OWNER_URLS, "webkit"],
      [config.LOCAL_BROWSER_FALLBACK_OWNER_URLS, "camoufox"],
    ]) {
      const response = await fetch(base! + "/health", {
        headers: {
          authorization: `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}`,
        },
      });
      expect((await response.json()).browserEngine).toBe(engine);
    }
    fixture = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/favicon.ico") {
        res.statusCode = 404;
        return res.end();
      }
      const firefox = /Firefox\//.test(req.headers["user-agent"] ?? "");
      if (url.pathname === "/wrong" || url.searchParams.get("skuId") !== "42")
        calls.wrong++;
      if (!url.searchParams.has("intl"))
        calls[firefox ? "firefox" : "webkit"]++;
      const mode = url.searchParams.get("mode");
      if (mode === "navigation" && !firefox && url.searchParams.has("intl"))
        return;
      res.setHeader("content-type", "text/html");
      if (firefox || url.searchParams.has("intl"))
        return res.end("<main>Original public product 42</main>");
      const destination = url.pathname + url.search + "&intl=nosplash";
      res.end(`<title>Owned country selector</title><h1>Choose a country</h1>
        <a href="/wrong?skuId=42&intl=nosplash">Other path</a><a href="${destination.replace("skuId=42", "skuId=43")}">Other SKU</a>
        <a href="${destination}">United States</a>
        ${mode === "document" ? `<script>Object.defineProperty(document.body,'innerText',{configurable:true,get:()=>new Promise(resolve=>setTimeout(()=>resolve('Choose a country'),10000))})</script>` : ""}`);
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
  const request = async (mode: string, fallback = true) => {
    const response = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${origin}/site/owned/42.p?skuId=42&mode=${mode}`,
        formats: ["rawHtml", "markdown"],
        timeout: 70000,
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
    "keeps the original country destination on an ordinary successful workflow",
    async () => {
      const before = { ...calls };
      const result = await request("happy");
      expect(result.status).toBe(200);
      expect(result.body.data.markdown).toContain("Original public product 42");
      const browser = result.body.data.metadata.browser;
      expect(browser.interaction.workflow.steps).toContainEqual({
        type: "country-selection",
        outcome: "navigated-original-product",
      });
      expect(
        browser.interaction.workflow.observations.countrySelection,
      ).toMatchObject({ discoveryTimeoutMs: 5000, navigationTimeoutMs: 30000 });
      expect(browser.diagnostics.engineFallback.attempted).toBe(false);
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
      expect(calls.wrong).toBe(0);
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "leaves alternate budget after a real document probe stalls and forwards its phase through the queue",
    async () => {
      const before = { ...calls };
      const result = await request("document");
      expect(result.status).toBe(200);
      expect(result.body.data.markdown).toContain("Original public product 42");
      const fallback =
        result.body.data.metadata.browser.diagnostics.engineFallback;
      expect(fallback.recovered).toBe(true);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[0]).toMatchObject({
        engine: "webkit",
        errorCode: "SCRAPE_TIMEOUT",
        pageClosed: true,
        contextClosed: true,
        document: { phase: "workflow-country-text" },
      });
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox - before.firefox).toBe(1);
      expect(calls.wrong).toBe(0);
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "caps native country navigation at thirty seconds and permits only one confirmed alternate",
    async () => {
      const before = { ...calls };
      const result = await request("navigation");
      expect(result.status).toBe(200);
      expect(result.body.data.markdown).toContain("Original public product 42");
      const fallback =
        result.body.data.metadata.browser.diagnostics.engineFallback;
      expect(fallback.recovered).toBe(true);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[0]).toMatchObject({
        engine: "webkit",
        errorCode: "SCRAPE_TIMEOUT",
        pageClosed: true,
        contextClosed: true,
        document: { phase: "workflow-country-navigation" },
      });
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox - before.firefox).toBe(1);
      expect(calls.wrong).toBe(0);
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "returns a closed phase receipt without replay when the caller did not opt into fallback",
    async () => {
      const before = { ...calls };
      const result = await request("document", false);
      expect(result.status).toBe(500);
      expect(result.body.code).toBe("SCRAPE_TIMEOUT");
      expect(result.body.diagnostics.attempts[0]).toMatchObject({
        engine: "webkit",
        pageClosed: true,
        contextClosed: true,
        document: { phase: "workflow-country-text" },
      });
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
    },
    scrapeTimeout,
  );
});
