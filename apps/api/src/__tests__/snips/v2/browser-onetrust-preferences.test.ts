import http from "node:http";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_ONETRUST_PREFERENCES_API === "true";
describe("Queued API OneTrust native preference workflow", () => {
  const port = Number(
    process.env.TEST_ONETRUST_PREFERENCES_FIXTURE_PORT ?? 33399,
  );
  let fixture: http.Server | undefined;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      const unknown = req.url === "/unknown";
      res.end(`<!doctype html><title>Owned API product</title><style>[hidden]{display:none!important}#onetrust-banner-sdk{position:fixed;bottom:0;background:white;z-index:2}#onetrust-pc-sdk{position:fixed;inset:10px;background:white;z-index:3}.category-switch-handler{position:absolute;opacity:0;width:0;height:0}.ot-switch{display:block;padding:15px}</style>
        <main>Original public product 42</main><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#details').hidden=false">Product Details</button><section id="details" hidden>Expanded public details 42</section>
        <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler" onclick="document.querySelector('#accepts').textContent='1'">Accept All Cookies</button></div>
        <button data-cookie-settings aria-haspopup="dialog" onclick="document.querySelector('#onetrust-pc-sdk').hidden=false">Cookie Settings</button>
        <div id="onetrust-pc-sdk" hidden><div class="ot-cat-item" data-optanongroupid="C0001">${unknown ? '<input type="checkbox" class="category-switch-handler" id="ot-group-id-C0001" data-optanongroupid="C0001" checked>' : '<div class="ot-always-active">Always Active</div>'}</div>
        ${["C0002", "C0003", "C0004"].map(group => `<input type="checkbox" class="category-switch-handler" id="ot-group-id-${group}" data-optanongroupid="${group}" ${group === "C0003" ? "" : "checked"} onchange="document.querySelector('#toggles').textContent=String(Number(document.querySelector('#toggles').textContent)+1)"><label class="ot-switch" for="ot-group-id-${group}">Optional category</label>`).join("")}
        <button class="save-preference-btn-handler" onclick="document.querySelector('#saves').textContent='1';document.querySelector('#saved').textContent=Array.from(document.querySelectorAll('input.category-switch-handler')).map(i=>i.checked?'1':'0').join('');document.querySelector('#onetrust-pc-sdk').hidden=true;document.querySelector('#onetrust-banner-sdk').hidden=true">Confirm My Choices</button></div>
        <output id="saved">unset</output><output id="saves">0</output><output id="toggles">0</output><output id="accepts">0</output>`);
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
  const request = async (mode: string) => {
    const response = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://owned.canadagoose.com:${port}/${mode}`,
        formats: ["rawHtml", "markdown"],
        timeout: 30000,
        browserControls: {
          consent: "rejectNonEssential",
          workflow: "auto",
          engineFallback: false,
          readiness: { text: "Expanded public details 42", timeoutMs: 300 },
        },
      }),
      signal: AbortSignal.timeout(scrapeTimeout),
    });
    return { status: response.status, body: await response.json() };
  };
  itIf(enabled)(
    "forwards verified category choices and expands the now-uncovered content",
    async () => {
      const result = await request("footer");
      expect(result.status).toBe(200);
      const data = result.body.data;
      const browser = data.metadata.browser;
      expect(browser.interaction.consent).toMatchObject({
        policy: "rejectNonEssential",
        outcome: "applied",
        preferenceCenter: {
          outcome: "applied",
          categoriesFound: 3,
          categoriesChanged: 2,
          saveAttempted: true,
          saveCompleted: true,
        },
      });
      expect(
        browser.interaction.workflow.observations.productDetails.outcome,
      ).toBe("expanded");
      expect(browser.readiness.satisfied).toBe(true);
      expect(data.rawHtml).toContain('<output id="saved">000</output>');
      expect(data.rawHtml).toContain('<output id="accepts">0</output>');
      expect(browser.diagnostics.engineFallback).toBeUndefined();
      expect(browser.diagnostics.attempts).toHaveLength(1);
      expect(browser.diagnostics.attempts[0]).toMatchObject({
        pageClosed: true,
        contextClosed: true,
      });
    },
  );
  itIf(enabled)(
    "leaves an unsupported required-category layout unresolved without saving or accepting",
    async () => {
      const result = await request("unknown");
      expect(result.status).toBe(200);
      const data = result.body.data;
      const browser = data.metadata.browser;
      expect(browser.interaction.consent).toMatchObject({
        policy: "rejectNonEssential",
        outcome: "unresolved",
        preferenceCenter: {
          outcome: "unresolved",
          reason: "unsupported_layout",
          categoriesChanged: 0,
          saveAttempted: false,
          saveCompleted: false,
        },
      });
      expect(browser.readiness.satisfied).toBe(false);
      expect(data.rawHtml).toContain('<output id="saves">0</output>');
      expect(data.rawHtml).toContain('<output id="toggles">0</output>');
      expect(data.rawHtml).toContain('<output id="accepts">0</output>');
      expect(browser.diagnostics.engineFallback).toBeUndefined();
      expect(browser.diagnostics.attempts).toHaveLength(1);
      expect(browser.diagnostics.attempts[0]).toMatchObject({
        pageClosed: true,
        contextClosed: true,
      });
    },
  );
});
