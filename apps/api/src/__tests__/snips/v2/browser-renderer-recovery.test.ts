import http from "node:http";
import { execFileSync } from "node:child_process";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_RENDERER_RECOVERY_API === "true";
describe("Full API recovery from an owned WebKit renderer fault", () => {
  const port = Number(process.env.TEST_RENDERER_FIXTURE_PORT ?? 33393);
  const origin = `http://host.docker.internal:${port}`;
  let server: http.Server | undefined;
  let received: (() => void) | undefined;
  let firefoxCalls = 0;
  beforeAll(async () => {
    if (!enabled) return;
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (/Firefox\//.test(req.headers["user-agent"] ?? "")) {
        firefoxCalls++;
        return res.end("<main>Owned renderer fallback record 42</main>");
      }
      res.write("<main>Owned renderer fault in progress</main>");
      received?.();
    });
    await new Promise<void>(resolve =>
      server!.listen(port, "0.0.0.0", resolve),
    );
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>(resolve => {
        server!.close(() => resolve());
        server!.closeAllConnections();
      });
  });
  const killOwnedRenderer = () => {
    const container = process.env.TEST_RENDERER_CONTAINER!;
    expect(container).toMatch(
      /^autogtm-firecrawl-renderer-api-webkit-20261104$/,
    );
    const info = JSON.parse(
      execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
    )[0];
    expect(info.State.Running).toBe(true);
    expect(info.Config.Labels["firecrawl.test"]).toBe(
      "renderer-recovery-2026-11-04",
    );
    expect(info.Image).toBe(process.env.TEST_RENDERER_IMAGE_ID);
    const script = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.ok(fs.existsSync('/.dockerenv'));const entries=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).flatMap(p=>{try{const status=fs.readFileSync('/proc/'+p+'/status','utf8');return /^Name:\\s*(?:WPEWebProcess|WebKitWebProces)/m.test(status)?[{pid:Number(p),status}]:[]}catch{return []}});assert.equal(entries.length,1);assert.match(entries[0].status,/^Uid:\\s*1000\\s+1000\\s+1000\\s+1000$/m);assert.match(entries[0].status,/^CapEff:\\s*0+$/m);process.kill(entries[0].pid,'SIGKILL');process.stdout.write(JSON.stringify({signal:'SIGKILL',pid:entries[0].pid}));`;
    return JSON.parse(
      execFileSync("docker", ["exec", container, "node", "-e", script], {
        encoding: "utf8",
        timeout: 5000,
      }),
    );
  };
  const faultRequest = async (fallback: boolean) => {
    let timer: NodeJS.Timeout | undefined;
    const requested = new Promise<void>((resolve, reject) => {
      received = resolve;
      timer = setTimeout(
        () => reject(new Error("Owned primary fixture was not requested")),
        8000,
      );
    });
    const pending = fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: origin + "/crash?token=private-fixture-value",
        formats: ["markdown"],
        timeout: 30000,
        browserControls: {
          workflow: "auto",
          ...(fallback ? { engineFallback: true } : {}),
        },
      }),
      signal: AbortSignal.timeout(scrapeTimeout),
    });
    void pending.catch(() => {});
    try {
      await requested;
      const fault = killOwnedRenderer();
      expect(fault.signal).toBe("SIGKILL");
      const response = await pending;
      return { status: response.status, body: await response.json() };
    } finally {
      clearTimeout(timer);
      received = undefined;
    }
  };
  const health = async () => {
    const response = await fetch(config.LOCAL_BROWSER_OWNER_URLS! + "/health", {
      headers: { authorization: `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}` },
    });
    return response.json();
  };
  itIf(enabled)(
    "recovers a confirmed closed crash exactly once through the queue and API",
    async () => {
      const before = firefoxCalls;
      const result = await faultRequest(true);
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data.markdown).toContain(
        "Owned renderer fallback record 42",
      );
      const fallback =
        result.body.data.metadata.browser.diagnostics.engineFallback;
      expect(fallback.recovered).toBe(true);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[0]).toMatchObject({
        engine: "webkit",
        errorCode: "PAGE_CRASHED",
        pageClosed: true,
        document: { rendererCrashed: true, phase: "navigation" },
      });
      expect(fallback.attempts[1]).toMatchObject({
        engine: "camoufox",
        pageClosed: true,
      });
      expect(firefoxCalls - before).toBe(1);
      expect(await health()).toMatchObject({
        activePages: 0,
        browserSessions: 0,
      });
    },
  );
  itIf(enabled)(
    "keeps an opt-out failure diagnostic through queue serialization without replay",
    async () => {
      const before = firefoxCalls;
      const result = await faultRequest(false);
      expect(result.status).toBe(500);
      expect(result.body.success).toBe(false);
      expect(result.body.code).toBe("PAGE_CRASHED");
      expect(result.body.diagnostics.attempts).toHaveLength(1);
      expect(result.body.diagnostics.attempts[0]).toMatchObject({
        engine: "webkit",
        errorCode: "PAGE_CRASHED",
        pageClosed: true,
        document: { rendererCrashed: true, phase: "navigation" },
      });
      expect(JSON.stringify(result.body.diagnostics)).not.toContain(
        "private-fixture-value",
      );
      expect(firefoxCalls).toBe(before);
      expect(await health()).toMatchObject({
        activePages: 0,
        browserSessions: 0,
      });
    },
  );
});
