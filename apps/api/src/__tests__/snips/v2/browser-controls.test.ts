import http from "node:http";
import { randomUUID } from "node:crypto";
import { scrapeTimeout } from "./lib";
import { config } from "../../../config";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

describe("Self-hosted local browser controls", () => {
  let fixture: http.Server;
  let origin: string;
  const fixtureRequests = new Map<string, number>();
  beforeAll(async () => {
    fixture = http.createServer((req, res) => {
      fixtureRequests.set(
        req.url ?? "",
        (fixtureRequests.get(req.url ?? "") ?? 0) + 1,
      );
      res.setHeader("content-type", "text/html");
      if (req.url === "/shell")
        return res.end(
          '<main>Loading...</main><script>setTimeout(()=>document.body.innerHTML="<main>Automatic API content 42</main>",350)</script>',
        );
      if (req.url === "/empty")
        return res.end("<title>Metadata only</title><main></main>");
      if (req.url === "/transient-gate")
        return res.end(
          '<main id="sec-if-cpt-container" style="display:none"><div id="sec-bc-tile-container"></div><button id="progress-button" disabled></button><img class="scf-akamai-logo"></main><script>setTimeout(()=>document.body.innerHTML="<main>Automatic API content 42</main>",350)</script>',
        );
      if (req.url === "/verification")
        return res.end(
          '<main id="sec-if-cpt-container" style="display:none"><div id="sec-bc-tile-container"></div><button id="progress-button" disabled></button><img class="scf-akamai-logo"></main>',
        );
      if (req.url === "/late")
        return res.end(
          '<title>Late</title><main>Loading</main><script>setTimeout(()=>document.body.innerHTML="<main id=ready>API late content 42</main>",500)</script>',
        );
      res.end(
        "<title>Workflow</title><main id=state>Initial content</main><button id=next onclick=\"sessionStorage.setItem('state','42');document.querySelector('#state').textContent='API retained tab 42'\">Next</button>",
      );
    });
    await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(fixture.address() as any).port}`;
  });
  afterAll(async () => {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  });
  const request = async (path: string, body?: unknown, method = "POST") => {
    const response = await fetch(`${TEST_API_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.TEST_API_KEY ?? "test"}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };
  const enabled = TEST_SELF_HOST && !!config.PLAYWRIGHT_MICROSERVICE_URL;
  itIf(enabled && config.LOCAL_BROWSER_OWNER_URLS?.split(",").length === 2)(
    "uses both configured owners for stateless scrapes through the full API",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request("/v2/scrape", {
            url: `${origin}/pool/${i}`,
            formats: ["rawHtml"],
            maxAge: 0,
            timeout: scrapeTimeout,
            waitFor: 200,
            browserControls: { waitUntil: "domcontentloaded" },
          }),
        ),
      );
      const counts = new Map<string, number>();
      for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.body.data.rawHtml).toContain("Initial content");
        const boot = result.body.data.metadata.browser.diagnostics.ownerBootId;
        expect(boot).toMatch(/^[a-f0-9-]{36}$/);
        counts.set(boot, (counts.get(boot) ?? 0) + 1);
      }
      expect([...counts.values()].sort()).toEqual([3, 3]);
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "waits for ordinary rendered content without a marker hint and preserves typed empty/verification failures",
    async () => {
      const ready = await request("/v2/scrape", {
        url: `${origin}/shell`,
        formats: ["rawHtml", "markdown"],
        maxAge: 0,
        waitFor: 0,
        timeout: scrapeTimeout,
        browserControls: { workflow: "auto", waitUntil: "domcontentloaded" },
      });
      expect(ready.status).toBe(200);
      expect(ready.body.data.markdown).toContain("Automatic API content 42");
      expect(ready.body.data.rawHtml).toContain(
        "<main>Automatic API content 42</main>",
      );
      expect(ready.body.data.metadata.browser.readiness.requested).toBe(false);
      expect(ready.body.data.metadata.browser.readiness.automatic.outcome).toBe(
        "ready",
      );
      const transitioned = await request("/v2/scrape", {
        url: `${origin}/transient-gate`,
        formats: ["rawHtml", "markdown"],
        maxAge: 0,
        waitFor: 0,
        timeout: scrapeTimeout,
        browserControls: { workflow: "auto", waitUntil: "domcontentloaded" },
      });
      expect(transitioned.status).toBe(200);
      expect(transitioned.body.data.markdown).toContain(
        "Automatic API content 42",
      );
      for (const [path, code] of [
        ["/empty", "CONTENT_NOT_READY"],
        ["/verification", "VERIFICATION_REQUIRED"],
      ]) {
        const failed = await request("/v2/scrape", {
          url: origin + path,
          formats: ["rawHtml", "markdown"],
          maxAge: 0,
          waitFor: 0,
          timeout: scrapeTimeout,
          browserControls: { workflow: "auto", waitUntil: "domcontentloaded" },
        });
        expect(failed.status).toBe(422);
        expect(failed.body.success).toBe(false);
        expect(failed.body.code).toBe(code);
        expect(fixtureRequests.get(path)).toBe(1);
      }
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "forwards readiness through the API and returns a typed failure",
    async () => {
      const ready = await request("/v2/scrape", {
        url: `${origin}/late`,
        formats: ["rawHtml"],
        timeout: scrapeTimeout,
        maxAge: 0,
        browserControls: {
          waitUntil: "domcontentloaded",
          readiness: {
            selector: "#ready",
            text: "API late content 42",
            timeoutMs: 2000,
          },
        },
      });
      expect(ready.status).toBe(200);
      expect(ready.body.data.rawHtml).toContain("API late content 42");
      expect(ready.body.data.metadata.browser.readiness.satisfied).toBe(true);
      const unsupported = await request("/v2/scrape", {
        url: origin,
        browserControls: { workflow: "unknown@1" },
      });
      expect(unsupported.status).toBe(400);
    },
    scrapeTimeout,
  );
  itIf(enabled)(
    "creates a distributed session and resumes the same live tab through the API",
    async () => {
      const creationId = randomUUID();
      const created = await request("/v2/browser/sessions", {
        creationId,
        url: origin,
        timeout: scrapeTimeout,
      });
      expect(created.status).toBe(201);
      const id = created.body.id;
      const duplicate = await request("/v2/browser/sessions", {
        url: origin,
        timeout: scrapeTimeout,
        creationId,
      });
      expect(duplicate.body.id).toBe(id);
      try {
        const first = await request("/v2/scrape", {
          url: origin,
          formats: ["rawHtml"],
          timeout: scrapeTimeout,
          browserControls: { sessionId: id, continueSession: true },
          actions: [{ type: "click", selector: "#next" }],
        });
        expect(first.status).toBe(200);
        const second = await request("/v2/scrape", {
          url: origin,
          formats: ["rawHtml"],
          timeout: scrapeTimeout,
          browserControls: {
            sessionId: id,
            continueSession: true,
            readiness: { text: "API retained tab 42" },
          },
        });
        expect(second.body.data.rawHtml).toContain("API retained tab 42");
        expect(second.body.data.metadata.browser.sessionId).toBe(id);
        expect(second.body.data.metadata.browser.diagnostics.ownerBootId).toBe(
          first.body.data.metadata.browser.diagnostics.ownerBootId,
        );
        const handoff = await request(`/v2/browser/sessions/${id}/handoff`, {});
        expect(handoff.status).toBe(200);
        const ticket = handoff.body.viewPath.split("#")[1];
        const viewer = await fetch(
          `${TEST_API_URL}${handoff.body.viewPath.split("#")[0]}`,
        );
        expect(viewer.status).toBe(200);
        const viewerHtml = await viewer.text();
        expect(
          () =>
            new Function(viewerHtml.match(/<script>([\s\S]*?)<\/script>/)![1]),
        ).not.toThrow();
        const snapshot = await fetch(
          `${TEST_API_URL}/v2/browser/sessions/${id}/handoff/snapshot`,
          { headers: { "x-browser-handoff": ticket } },
        );
        expect(snapshot.status).toBe(200);
        expect((await snapshot.json()).image.length).toBeGreaterThan(100);
        const invalidTicket = await fetch(
          `${TEST_API_URL}/v2/browser/sessions/${id}/handoff/snapshot`,
          { headers: { "x-browser-handoff": "0".repeat(64) } },
        );
        expect(invalidTicket.status).toBe(403);
        const resumed = await request(`/v2/browser/sessions/${id}/resume`, {});
        expect(resumed.status).toBe(200);
        expect(resumed.body.content).toContain("API retained tab 42");
        expect(JSON.stringify(second.body)).not.toMatch(
          /"sessionId":"[a-f0-9]{64}"/,
        );
        const wrongOrigin = await request("/v2/scrape", {
          url: "https://example.org",
          browserControls: { sessionId: id, continueSession: true },
        });
        expect(wrongOrigin.status).toBeGreaterThanOrEqual(400);
      } finally {
        expect(
          (await request(`/v2/browser/sessions/${id}`, undefined, "DELETE"))
            .status,
        ).toBe(204);
      }
    },
    scrapeTimeout,
  );
});
