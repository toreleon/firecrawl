import http from "node:http";
import { config } from "../../config";
import { scrapeLocalBrowser } from "./client";

describe("Stateless local browser owner selection", () => {
  const original = config.LOCAL_BROWSER_OWNER_URLS;
  const servers: http.Server[] = [];
  afterEach(async () => {
    config.LOCAL_BROWSER_OWNER_URLS = original;
    await Promise.all(
      servers.splice(0).map(
        server =>
          new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });
  const owner = async (
    options: {
      unhealthy?: boolean;
      failedScrape?: boolean;
      lostResponse?: boolean;
      healthDelay?: number;
    } = {},
  ) => {
    const calls = { health: 0, scrape: 0 };
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        calls.health++;
        if (options.healthDelay)
          await new Promise(resolve =>
            setTimeout(resolve, options.healthDelay),
          );
        res.statusCode = options.unhealthy ? 503 : 200;
        return res.end(
          JSON.stringify({
            status: "healthy",
            ownerBootId: "fixture",
            capabilities: { version: 1, actions: [] },
          }),
        );
      }
      calls.scrape++;
      if (options.lostResponse) return req.socket.destroy();
      res.statusCode = options.failedScrape ? 500 : 200;
      res.end(
        JSON.stringify({
          content: "<main>Fixture</main>",
          pageStatusCode: 200,
        }),
      );
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
      base: `http://127.0.0.1:${(server.address() as any).port}`,
      calls,
    };
  };
  const scrape = (timeout = 2000, signal?: AbortSignal) =>
    scrapeLocalBrowser(null, "fixture", {
      url: "https://example.com/",
      timeout,
      signal,
      controls: {},
    });
  it("balances stateless commands over two healthy owners", async () => {
    const a = await owner(),
      b = await owner();
    config.LOCAL_BROWSER_OWNER_URLS = `${a.base},${b.base}`;
    await Promise.all(Array.from({ length: 8 }, () => scrape()));
    expect([a.calls.scrape, b.calls.scrape]).toEqual([4, 4]);
    expect([a.calls.health, b.calls.health]).toEqual([1, 1]);
  });
  it("falls back only before dispatch when an owner's health fails", async () => {
    const a = await owner({ unhealthy: true }),
      b = await owner();
    config.LOCAL_BROWSER_OWNER_URLS = `${a.base},${b.base}`;
    await scrape();
    await scrape();
    expect(a.calls.health).toBeGreaterThan(0);
    expect(a.calls.scrape).toBe(0);
    expect(b.calls.scrape).toBe(2);
  });
  it("does not dispatch again after a selected owner fails the command", async () => {
    const a = await owner({ failedScrape: true }),
      b = await owner({ failedScrape: true });
    config.LOCAL_BROWSER_OWNER_URLS = `${a.base},${b.base}`;
    await expect(scrape()).rejects.toMatchObject({
      code: "BROWSER_OPERATION_FAILED",
    });
    expect(a.calls.scrape + b.calls.scrape).toBe(1);
  });
  it("does not replay a command whose response was lost", async () => {
    const a = await owner({ lostResponse: true });
    const b = await owner({ lostResponse: true });
    config.LOCAL_BROWSER_OWNER_URLS = `${a.base},${b.base}`;
    await expect(scrape()).rejects.toMatchObject({
      code: "BROWSER_OUTCOME_UNKNOWN",
    });
    expect(a.calls.scrape + b.calls.scrape).toBe(1);
  });
  it("does not dispatch after a discovery deadline or cancellation", async () => {
    const a = await owner({ healthDelay: 350 });
    config.LOCAL_BROWSER_OWNER_URLS = a.base;
    const started = Date.now();
    await expect(scrape(100)).rejects.toMatchObject({ code: "SCRAPE_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(300);
    const cancellation = new AbortController();
    const pending = scrape(2000, cancellation.signal);
    setTimeout(() => cancellation.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "SCRAPE_CANCELLED" });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(a.calls.scrape).toBe(0);
    expect(a.calls.health).toBe(1);
    await scrape();
    expect(a.calls.scrape).toBe(1);
    expect(a.calls.health).toBe(1);
  });
});
