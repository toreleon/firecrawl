import http from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { scrapeLocalBrowser } from "./client";
import { scrapeRequestSchema } from "../../controllers/v2/types";

describe("Explicit stateless browser-engine fallback", () => {
  const prior = {
    primary: config.LOCAL_BROWSER_OWNER_URLS,
    fallback: config.LOCAL_BROWSER_FALLBACK_OWNER_URLS,
  };
  const servers: http.Server[] = [];
  afterEach(async () => {
    config.LOCAL_BROWSER_OWNER_URLS = prior.primary;
    config.LOCAL_BROWSER_FALLBACK_OWNER_URLS = prior.fallback;
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
      engine?: string;
      status?: number;
      apiStatus?: number;
      code?: string;
      closed?: boolean;
      lost?: boolean;
      unhealthy?: boolean;
      wrongBoot?: boolean;
      url?: string;
      navigationTimeout?: boolean;
      interactionState?: string;
    } = {},
  ) => {
    const boot = randomUUID();
    const calls = { health: 0, scrape: 0, bodies: [] as any[] };
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        calls.health++;
        res.statusCode = options.unhealthy ? 503 : 200;
        return res.end(
          JSON.stringify({
            status: "healthy",
            ownerBootId: boot,
            browserEngine: options.engine ?? "rebrowser",
            capabilities: {
              version: 1,
              actions: ["wait"],
              navigationTimeout: options.navigationTimeout,
            },
          }),
        );
      }
      calls.scrape++;
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      calls.bodies.push(JSON.parse(bytes));
      if (options.lost) return req.socket.destroy();
      const status = options.status ?? 200;
      res.statusCode = options.apiStatus ?? 200;
      const diagnostics = {
        ownerBootId: options.wrongBoot ? randomUUID() : boot,
        attempts: [{ attempt: 1, pageClosed: options.closed ?? true }],
      };
      res.end(
        JSON.stringify(
          options.code
            ? { errorCode: options.code, diagnostics }
            : {
                content:
                  status === 200
                    ? "<main>Recovered public record</main>"
                    : "<main>Blocked public record</main>",
                ...(options.url === undefined ? {} : { url: options.url }),
                pageStatusCode: status,
                browserEngine: options.engine ?? "rebrowser",
                readiness: { satisfied: true },
                ...(options.interactionState === undefined
                  ? {}
                  : { interaction: { state: options.interactionState } }),
                diagnostics,
                ...(status !== 200
                  ? { pageError: "Target denied access" }
                  : {}),
              },
        ),
      );
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
      base: `http://127.0.0.1:${(server.address() as any).port}`,
      calls,
    };
  };
  const request = (overrides: Record<string, any> = {}) =>
    scrapeLocalBrowser(null, "fixture", {
      url: "https://example.com/public-record",
      timeout: 10000,
      controls: { engineFallback: true },
      ...overrides,
    });
  const configure = async (
    primaryOptions: Parameters<typeof owner>[0] = {},
    secondaryOptions: Parameters<typeof owner>[0] = {},
  ) => {
    const primary = await owner(primaryOptions);
    const fallback = await owner({ engine: "camoufox", ...secondaryOptions });
    config.LOCAL_BROWSER_OWNER_URLS = primary.base;
    config.LOCAL_BROWSER_FALLBACK_OWNER_URLS = fallback.base;
    return { primary, fallback };
  };
  it("forwards the navigation cap to both capable engines and skips an older alternate", async () => {
    const { primary, fallback } = await configure(
      { status: 403, navigationTimeout: true },
      { navigationTimeout: true },
    );
    const result = await request({
      controls: { engineFallback: true, navigationTimeout: 300 },
    });
    expect(result.diagnostics.engineFallback.recovered).toBe(true);
    expect(primary.calls.bodies[0].navigation_timeout).toBe(300);
    expect(fallback.calls.bodies[0].navigation_timeout).toBe(300);
    const old = await owner({ engine: "camoufox" });
    config.LOCAL_BROWSER_FALLBACK_OWNER_URLS = old.base;
    const skipped = await request({
      controls: { engineFallback: true, navigationTimeout: 300 },
    });
    expect(skipped.diagnostics.engineFallback.skipped).toBe(
      "no_distinct_healthy_backend",
    );
    expect(old.calls.scrape).toBe(0);
  });
  it("accepts the policy without forwarding it as a browser operation, and rejects interactive combinations", () => {
    expect(
      scrapeRequestSchema.parse({
        url: "https://example.com",
        browserControls: { engineFallback: true },
      }).browserControls?.engineFallback,
    ).toBe(true);
    for (const extra of [
      { browserControls: { engineFallback: true, sessionId: randomUUID() } },
      { browserControls: { engineFallback: true, maxAttempts: 2 } },
      {
        browserControls: { engineFallback: true },
        actions: [{ type: "wait", milliseconds: 1 }],
      },
    ])
      expect(
        scrapeRequestSchema.safeParse({ url: "https://example.com", ...extra })
          .success,
      ).toBe(false);
  });
  it("recovers a completed HTTP denial on a distinct backend within the same deadline", async () => {
    const { primary, fallback } = await configure({ status: 403 });
    const result = await request();
    expect(result.pageStatusCode).toBe(200);
    expect(result.diagnostics.engineFallback.usedSecondary).toBe(true);
    expect(result.diagnostics.engineFallback.attempts).toHaveLength(2);
    expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
    expect(fallback.calls.bodies[0].timeout).toBeLessThanOrEqual(
      primary.calls.bodies[0].timeout,
    );
    expect(fallback.calls.bodies[0].engineFallback).toBeUndefined();
    expect(fallback.calls.bodies[0].max_attempts).toBe(1);
  });
  it("recovers a completed network failure whose page closure and owner are confirmed", async () => {
    const { primary, fallback } = await configure({
      apiStatus: 500,
      code: "NETWORK_ERROR",
    });
    const result = await request();
    expect(result.pageStatusCode).toBe(200);
    expect(result.diagnostics.engineFallback.attempts[0].errorCode).toBe(
      "NETWORK_ERROR",
    );
    expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
  });
  it.each(["HUMAN_REQUIRED", "VERIFICATION_REQUIRED"])(
    "recovers a completed %s workflow gate without a legacy bot signature",
    async interactionState => {
      const { primary, fallback } = await configure(
        { interactionState },
        { interactionState: "CONTENT_READY" },
      );
      const result = await request();
      expect(result.interaction.state).toBe("CONTENT_READY");
      expect(result.diagnostics.engineFallback.recovered).toBe(true);
      expect(result.diagnostics.engineFallback.attempts).toHaveLength(2);
      expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
    },
  );
  it.each([
    "HUMAN_REQUIRED",
    "VERIFICATION_REQUIRED",
    "AUTH_REQUIRED",
    "REGION_UNAVAILABLE",
    "COUNTRY_SELECTION",
    "ACCESS_DENIED",
    "CONTENT_NOT_READY",
    "UNKNOWN_FUTURE_STATE",
  ])(
    "does not promote an HTTP 200 alternate declaring %s",
    async interactionState => {
      const { primary, fallback } = await configure(
        { status: 403 },
        { interactionState },
      );
      const result = await request();
      expect(result.pageStatusCode).toBe(403);
      expect(result.diagnostics.engineFallback.recovered).toBe(false);
      expect(result.diagnostics.engineFallback.usedSecondary).toBe(false);
      expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
    },
  );
  it("can recover a completed target HTTP 400 without treating browser-service validation errors as target failures", async () => {
    const pair = await configure({ status: 400 });
    const result = await request();
    expect(result.pageStatusCode).toBe(200);
    expect(result.diagnostics.engineFallback.recovered).toBe(true);
    expect(result.diagnostics.engineFallback.attempts[0].pageStatusCode).toBe(
      400,
    );
    expect([pair.primary.calls.scrape, pair.fallback.calls.scrape]).toEqual([
      1, 1,
    ]);
    const invalid = await configure({
      apiStatus: 400,
      code: "INVALID_OPTIONS",
    });
    await expect(request()).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect([
      invalid.primary.calls.scrape,
      invalid.fallback.calls.scrape,
    ]).toEqual([1, 0]);
  });
  it("keeps target HTTP 400 terminal without opt-in or confirmed cleanup and owner identity", async () => {
    for (const options of [
      { status: 400, closed: false },
      { status: 400, wrongBoot: true },
    ]) {
      const pair = await configure(options);
      expect((await request()).pageStatusCode).toBe(400);
      expect(pair.fallback.calls.scrape).toBe(0);
    }
    const pair = await configure({ status: 400 });
    expect((await request({ controls: {} })).pageStatusCode).toBe(400);
    expect(pair.fallback.calls.scrape).toBe(0);
  });
  it("recovers a confirmed HTTP reset response from the filtering proxy", async () => {
    const { primary, fallback } = await configure({ status: 595 });
    const result = await request();
    expect(result.pageStatusCode).toBe(200);
    expect(result.diagnostics.engineFallback.attempts[0].pageStatusCode).toBe(
      595,
    );
    expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
  });
  const amazon = "https://www.amazon.com/Product/dp/B000000042";
  it("can fetch the original Amazon product on a distinct engine after confirmed identity-failure cleanup", async () => {
    const pair = await configure(
      { apiStatus: 500, code: "WORKFLOW_NAVIGATION_MISMATCH" },
      { url: amazon },
    );
    const result = await request({
      url: amazon,
      controls: { workflow: "auto", engineFallback: true },
    });
    expect(result.url).toBe(amazon);
    expect(result.diagnostics.engineFallback.recovered).toBe(true);
    expect(result.diagnostics.engineFallback.attempts[0].errorCode).toBe(
      "WORKFLOW_NAVIGATION_MISMATCH",
    );
    expect(pair.primary.calls.bodies[0].url).toBe(amazon);
    expect(pair.fallback.calls.bodies[0].url).toBe(amazon);
    expect([pair.primary.calls.scrape, pair.fallback.calls.scrape]).toEqual([
      1, 1,
    ]);
  });
  it("keeps identity failures terminal outside the explicit Amazon auto-workflow policy", async () => {
    for (const overrides of [
      { url: amazon, controls: { workflow: "auto" } },
      { url: amazon, controls: { engineFallback: true } },
      {
        url: "https://example.com/dp/B000000042",
        controls: { workflow: "auto", engineFallback: true },
      },
      {
        url: "https://www.amazon.com.attacker.test/dp/B000000042",
        controls: { workflow: "auto", engineFallback: true },
      },
      {
        url: "https://www.amazon.com:444/dp/B000000042",
        controls: { workflow: "auto", engineFallback: true },
      },
      {
        url: "http://www.amazon.com/dp/B000000042",
        controls: { workflow: "auto", engineFallback: true },
      },
      {
        url: "https://user@www.amazon.com/dp/B000000042",
        controls: { workflow: "auto", engineFallback: true },
      },
    ]) {
      const pair = await configure(
        { apiStatus: 500, code: "WORKFLOW_NAVIGATION_MISMATCH" },
        { url: amazon },
      );
      await expect(request(overrides)).rejects.toMatchObject({
        code: "WORKFLOW_NAVIGATION_MISMATCH",
      });
      expect(pair.fallback.calls.scrape).toBe(0);
    }
  });
  it("does not replay identity errors without verified owner and closed-page proof", async () => {
    for (const extra of [{ closed: false }, { wrongBoot: true }]) {
      const pair = await configure(
        { apiStatus: 500, code: "WORKFLOW_NAVIGATION_MISMATCH", ...extra },
        { url: amazon },
      );
      await expect(
        request({
          url: amazon,
          controls: { workflow: "auto", engineFallback: true },
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_NAVIGATION_MISMATCH" });
      expect(pair.fallback.calls.scrape).toBe(0);
    }
  });
  it("guards successful old-owner responses too and never promotes a wrong-product alternate", async () => {
    const wrong = amazon.replace("B000000042", "B000000043");
    const pair = await configure({ url: wrong }, { url: amazon });
    const result = await request({
      url: amazon,
      controls: { workflow: "auto", engineFallback: true },
    });
    expect(result.url).toBe(amazon);
    expect(result.diagnostics.engineFallback.attempts[0].errorCode).toBe(
      "WORKFLOW_NAVIGATION_MISMATCH",
    );
    expect([pair.primary.calls.scrape, pair.fallback.calls.scrape]).toEqual([
      1, 1,
    ]);
    for (const url of [wrong, "https://example.com/dp/B000000042", undefined]) {
      const next = await configure(
        { apiStatus: 500, code: "WORKFLOW_NAVIGATION_MISMATCH" },
        { url },
      );
      await expect(
        request({
          url: amazon,
          controls: { workflow: "auto", engineFallback: true },
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_NAVIGATION_MISMATCH" });
      expect([next.primary.calls.scrape, next.fallback.calls.scrape]).toEqual([
        1, 1,
      ]);
    }
  });
  it("retains a known primary denial if a closed alternate presents the wrong Amazon product", async () => {
    const pair = await configure(
      { status: 403, url: amazon },
      { url: amazon.replace("B000000042", "B000000043") },
    );
    const result = await request({
      url: amazon,
      controls: { workflow: "auto", engineFallback: true },
    });
    expect(result.pageStatusCode).toBe(403);
    expect(result.diagnostics.engineFallback.recovered).toBe(false);
    expect(result.diagnostics.engineFallback.attempts[1].errorCode).toBe(
      "WORKFLOW_NAVIGATION_MISMATCH",
    );
    expect([pair.primary.calls.scrape, pair.fallback.calls.scrape]).toEqual([
      1, 1,
    ]);
  });
  it("does not activate after primary success or without the opt-in", async () => {
    let pair = await configure();
    expect((await request()).pageStatusCode).toBe(200);
    expect(pair.fallback.calls.health).toBe(0);
    pair = await configure({ status: 403 });
    expect((await request({ controls: {} })).pageStatusCode).toBe(403);
    expect(pair.fallback.calls.health).toBe(0);
  });
  it("shares stateless fallback requests between configured healthy alternate owners", async () => {
    const primary = await owner({ status: 403 });
    const first = await owner({ engine: "camoufox" });
    const second = await owner({ engine: "camoufox" });
    config.LOCAL_BROWSER_OWNER_URLS = primary.base;
    config.LOCAL_BROWSER_FALLBACK_OWNER_URLS = `${first.base},${second.base}`;
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request()),
    );
    expect(
      responses.every(
        response => response.diagnostics.engineFallback.recovered,
      ),
    ).toBe(true);
    expect(primary.calls.scrape).toBe(8);
    expect([first.calls.scrape, second.calls.scrape]).toEqual([4, 4]);
    expect(
      new Set(
        responses.map(
          response =>
            response.diagnostics.engineFallback.attempts[1].ownerBootId,
        ),
      ).size,
    ).toBe(2);
  });
  it("does not try another pool member after an alternate response is lost", async () => {
    const primary = await owner({ status: 403 });
    const first = await owner({ engine: "camoufox", lost: true });
    const second = await owner({ engine: "camoufox", lost: true });
    config.LOCAL_BROWSER_OWNER_URLS = primary.base;
    config.LOCAL_BROWSER_FALLBACK_OWNER_URLS = `${first.base},${second.base}`;
    await expect(request()).rejects.toMatchObject({
      code: "BROWSER_OUTCOME_UNKNOWN",
    });
    expect(primary.calls.scrape).toBe(1);
    expect(first.calls.scrape + second.calls.scrape).toBe(1);
  });
  it("does not replay a lost response, unclosed page or wrong-owner result", async () => {
    for (const options of [
      { lost: true },
      { apiStatus: 500, code: "NETWORK_ERROR", closed: false },
      { apiStatus: 500, code: "NETWORK_ERROR", wrongBoot: true },
    ]) {
      const { primary, fallback } = await configure(options);
      await expect(request()).rejects.toBeDefined();
      expect(primary.calls.scrape).toBe(1);
      expect(fallback.calls.scrape).toBe(0);
    }
  });
  it("keeps the original denial when closure, a distinct engine or fallback health is unavailable", async () => {
    for (const [primaryOptions, secondaryOptions] of [
      [{ status: 403, closed: false }, {}],
      [{ status: 403 }, { engine: "rebrowser" }],
      [{ status: 403 }, { unhealthy: true }],
    ]) {
      const pair = await configure(primaryOptions, secondaryOptions);
      expect((await request()).pageStatusCode).toBe(403);
      expect(pair.fallback.calls.scrape).toBe(0);
    }
  });
  it("retains the known primary response when an attempted alternate also fails", async () => {
    const { primary, fallback } = await configure(
      { status: 403 },
      { apiStatus: 500, code: "NETWORK_ERROR" },
    );
    const result = await request();
    expect(result.pageStatusCode).toBe(403);
    expect(result.diagnostics.engineFallback.usedSecondary).toBe(false);
    expect(result.diagnostics.engineFallback.attempts).toHaveLength(2);
    expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
  });
  it("does not replay after an alternate response is lost", async () => {
    const { primary, fallback } = await configure(
      { status: 403 },
      { lost: true },
    );
    await expect(request()).rejects.toMatchObject({
      code: "BROWSER_OUTCOME_UNKNOWN",
    });
    expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([1, 1]);
  });
  it("does not spend a second dispatch when the original deadline is nearly exhausted", async () => {
    const { fallback } = await configure({ status: 403 });
    const result = await request({ timeout: 500 });
    expect(result.pageStatusCode).toBe(403);
    expect(result.diagnostics.engineFallback.skipped).toBe(
      "insufficient_budget",
    );
    expect(fallback.calls.scrape).toBe(0);
  });
  it("rejects retained tabs, actions and internal retries before any dispatch", async () => {
    const { primary, fallback } = await configure({ status: 403 });
    for (const extra of [
      { controls: { engineFallback: true, sessionId: randomUUID() } },
      { controls: { engineFallback: true, maxAttempts: 2 } },
      { actions: [{ type: "wait", milliseconds: 1 }] },
    ])
      await expect(request(extra)).rejects.toMatchObject({
        code: "BROWSER_FALLBACK_UNSUPPORTED",
      });
    expect([primary.calls.scrape, fallback.calls.scrape]).toEqual([0, 0]);
  });
});
