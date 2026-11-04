import http from "node:http";
import { writeFile, rename } from "node:fs/promises";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled = TEST_SELF_HOST && process.env.TEST_OWNER_HEALTH_API === "true";
describe("Queued API browser-owner health ownership", () => {
  let fixture: http.Server | undefined;
  let served = 0;
  const port = Number(process.env.TEST_OWNER_HEALTH_FIXTURE_PORT ?? 33400);
  const control = async (value: object) => {
    const file = process.env.TEST_OWNER_HEALTH_CONTROL_FILE!;
    await writeFile(file + ".next", JSON.stringify(value));
    await rename(file + ".next", file);
  };
  beforeAll(async () => {
    if (!enabled) return;
    await control({});
    fixture = http.createServer((req, res) => {
      const name = new URL(req.url!, "http://owned-health.test").pathname.slice(
        1,
      );
      if (!/^(concurrent-\d+|unhealthy|recovered)$/.test(name)) {
        res.statusCode = 204;
        return res.end();
      }
      served++;
      res.setHeader("content-type", "text/html");
      res.end(`<main>Owned health integration record ${name}</main>`);
    });
    await new Promise<void>(resolve =>
      fixture!.listen(port, "0.0.0.0", resolve),
    );
  });
  afterAll(async () => {
    if (enabled) await control({});
    if (fixture)
      await new Promise<void>(resolve => {
        fixture!.close(() => resolve());
        fixture!.closeAllConnections();
      });
  });
  const request = async (name: string) => {
    const r = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://owned-health.test:${port}/${name}`,
        formats: ["rawHtml", "markdown"],
        maxAge: 0,
        storeInCache: false,
        timeout: 30000,
        browserControls: {
          waitUntil: "domcontentloaded",
          maxAttempts: 1,
          engineFallback: false,
        },
      }),
      signal: AbortSignal.timeout(scrapeTimeout),
    });
    return { status: r.status, body: await r.json() };
  };
  const expectReady = (
    result: Awaited<ReturnType<typeof request>>,
    name: string,
  ) => {
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.data.rawHtml).toContain(
      `Owned health integration record ${name}`,
    );
    const browser = result.body.data.metadata.browser;
    expect(browser.diagnostics.ownerBootId).toBeTruthy();
    expect(browser.diagnostics.attempts).toHaveLength(1);
    expect(browser.diagnostics.attempts[0]).toMatchObject({
      pageClosed: true,
      contextClosed: true,
    });
    return browser.diagnostics.ownerBootId;
  };
  itIf(enabled)(
    "routes eight concurrent queued scrapes with the same verified owner identity",
    async () => {
      const names = Array.from({ length: 8 }, (_, i) => "concurrent-" + i);
      const rows = await Promise.all(names.map(request));
      expect(
        new Set(rows.map((row, i) => expectReady(row, names[i]))).size,
      ).toBe(1);
      expect(served).toBe(8);
    },
  );
  itIf(enabled)(
    "returns the owner's unhealthy result without dispatching a target capture",
    async () => {
      const before = served;
      await control({ holdCreate: true });
      // The API's per-worker discovery cache is two seconds; force a fresh probe.
      await new Promise(resolve => setTimeout(resolve, 2200));
      try {
        const result = await request("unhealthy");
        expect(result.status).toBe(503);
        expect(result.body.success).toBe(false);
        expect(result.body.code).toBe("BROWSER_OPERATION_FAILED");
        expect(served).toBe(before);
      } finally {
        await control({});
      }
    },
  );
  itIf(enabled)(
    "resumes queued scraping after late health resources have closed",
    async () => {
      const end = Date.now() + 10000;
      let ready = false;
      while (Date.now() < end) {
        const r = await fetch(config.LOCAL_BROWSER_OWNER_URLS! + "/health", {
          headers: {
            authorization: "Bearer " + config.BROWSER_SERVICE_AUTH_TOKEN,
          },
          signal: AbortSignal.timeout(6000),
        });
        if (r.ok) {
          ready = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(ready).toBe(true);
      expectReady(await request("recovered"), "recovered");
      expect(served).toBe(9);
    },
  );
});
