import http from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_FALLBACK_POOL_FIXTURE === "true";
describe("Full API fallback-owner distribution with controlled browser-protocol fixtures", () => {
  const servers: http.Server[] = [];
  const calls = {
    primary: [] as string[],
    first: [] as string[],
    second: [] as string[],
  };
  const active = { first: 0, second: 0 };
  const peak = { first: 0, second: 0 };
  const tail = { first: Promise.resolve(), second: Promise.resolve() };
  let maximumParallelAlternates = 0;
  beforeAll(async () => {
    if (!enabled) return;
    const alternates = config.LOCAL_BROWSER_FALLBACK_OWNER_URLS!.split(",");
    expect(alternates).toHaveLength(2);
    for (const [role, address] of [
      ["primary", config.LOCAL_BROWSER_OWNER_URLS!],
      ["first", alternates[0]],
      ["second", alternates[1]],
    ] as const) {
      const base = new URL(address);
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
              ownerBootId: boot,
              browserEngine: role === "primary" ? "rebrowser" : "camoufox",
              capabilities: { version: 1, actions: [] },
              maxConcurrentPages: 1,
            }),
          );
        let bytes = "";
        for await (const part of req) bytes += part;
        const body = JSON.parse(bytes);
        calls[role].push(body.url);
        const lost = new URL(body.url).searchParams.get("case") === "lost";
        const respond = () =>
          res.end(
            JSON.stringify({
              content: `<main>Original public record ${new URL(body.url).searchParams.get("item")}</main>`,
              renderedText: "Original public record",
              url: body.url,
              pageStatusCode: role === "primary" ? 403 : 200,
              readiness: { satisfied: true },
              diagnostics: {
                ownerBootId: boot,
                attempts: [{ attempt: 1, pageClosed: true }],
              },
              ...(role === "primary" ? { pageError: "Forbidden" } : {}),
            }),
          );
        if (role === "primary") return respond();
        if (lost) return req.socket.destroy();
        // Model one browser page slot per alternate owner. Replies on an owner
        // serialize, while distinct owners can do useful work concurrently.
        const operation = tail[role].then(async () => {
          active[role]++;
          peak[role] = Math.max(peak[role], active[role]);
          maximumParallelAlternates = Math.max(
            maximumParallelAlternates,
            active.first + active.second,
          );
          try {
            await new Promise(resolve => setTimeout(resolve, 400));
            respond();
          } finally {
            active[role]--;
          }
        });
        tail[role] = operation.catch(() => {});
        await operation;
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
  const scrape = (item: string, mode = "normal") =>
    fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.TEST_API_KEY ?? "test"}`,
      },
      body: JSON.stringify({
        url: `https://example.com/public-record?item=${item}&case=${mode}`,
        formats: ["rawHtml", "markdown"],
        maxAge: 0,
        storeInCache: false,
        waitFor: 0,
        timeout: scrapeTimeout,
        browserControls: {
          workflow: "auto",
          engineFallback: true,
          maxAttempts: 1,
        },
      }),
    });
  itIf(enabled)(
    "uses both configured alternate owners for eight concurrent API jobs",
    async () => {
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: 8 }, async (_, item) => {
          const response = await scrape(String(item));
          return {
            status: response.status,
            result: await response.json(),
            item,
          };
        }),
      );
      const receipt = {
        mode: "controlled-browser-protocol-capacity-model",
        requests: 8,
        clientConcurrency: 8,
        fixtureAlternateCapacity: 1,
        simulatedWorkMs: 400,
        batchElapsedMs: Math.round(performance.now() - started),
        primaryCalls: calls.primary.length,
        alternateCalls: {
          first: calls.first.length,
          second: calls.second.length,
        },
        maximumParallelAlternates,
        maximumActivePerOwner: peak,
        allApiSuccess: results.every(
          ({ status, result }) => status === 200 && result.success,
        ),
        successfulResults: results.map(({ status, result, item }) => ({
          item,
          status,
          statusCode: result.data?.metadata?.statusCode,
          fallback: result.data?.metadata?.browser?.diagnostics?.engineFallback,
        })),
      };
      // Retain the distribution and timing even when the failure-first assertion
      // rejects the old first-owner-only behavior. No public-site traffic occurs.
      if (process.env.TEST_FALLBACK_POOL_RECEIPT)
        await writeFile(
          process.env.TEST_FALLBACK_POOL_RECEIPT,
          JSON.stringify(receipt, null, 2) + "\n",
        );
      for (const { status, result, item } of results) {
        expect(status).toBe(200);
        expect(result.data.markdown).toContain(
          `Original public record ${item}`,
        );
        expect(
          result.data.metadata.browser.diagnostics.engineFallback.attempts,
        ).toHaveLength(2);
        expect(
          result.data.metadata.browser.diagnostics.engineFallback.recovered,
        ).toBe(true);
      }
      expect(calls.primary).toHaveLength(8);
      expect(calls.first.length + calls.second.length).toBe(8);
      expect(calls.first.length).toBeGreaterThan(0);
      expect(calls.second.length).toBeGreaterThan(0);
      expect(maximumParallelAlternates).toBe(2);
      expect(peak.first).toBe(1);
      expect(peak.second).toBe(1);
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "never uses another pool member after a dispatched alternate loses its response",
    async () => {
      const before = {
        primary: calls.primary.length,
        alternate: calls.first.length + calls.second.length,
      };
      const result = await (await scrape("lost", "lost")).json();
      expect(result.success).toBe(false);
      expect(result.code).toBe("BROWSER_OUTCOME_UNKNOWN");
      expect(calls.primary.length - before.primary).toBe(1);
      expect(calls.first.length + calls.second.length - before.alternate).toBe(
        1,
      );
    },
    scrapeTimeout,
  );
});
