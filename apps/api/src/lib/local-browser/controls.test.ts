import { randomUUID } from "node:crypto";
import {
  scrapeRequestSchema,
  batchScrapeRequestSchema,
  crawlRequestSchema,
  applyScrapeOptionsDefaults,
} from "../../controllers/v2/types";
import { hasCustomRequestContext } from "../../scraper/scrapeURL/lib/request-context";
import { redactRequestBodyForLog } from "../../scraper/scrapeURL/lib/fetch";
import { mapBrowserControls } from "./client";

describe("Local browser API contract boundaries", () => {
  it("permits an explicit automatic body budget without an oracle predicate", () => {
    const controls = scrapeRequestSchema.parse({
      url: "https://example.com",
      browserControls: { workflow: "auto", readiness: { timeoutMs: 750 } },
    }).browserControls;
    expect(mapBrowserControls(controls)).toEqual({
      workflow: "auto",
      readiness_timeout: 750,
    });
    for (const browserControls of [
      { readiness: { timeoutMs: 750 } },
      { workflow: "auto", readiness: {} },
      { workflow: "auto", readiness: { timeoutMs: 750, scope: "title" } },
    ])
      expect(
        scrapeRequestSchema.safeParse({
          url: "https://example.com",
          browserControls,
        }).success,
      ).toBe(false);
  });
  it("requires live execution and keeps TLS defaults coherent for retained sessions", () => {
    const request = scrapeRequestSchema.parse({
      url: "https://example.com",
      browserControls: { readiness: { selector: "main", text: "Company 42" } },
    });
    expect(request.skipTlsVerification).toBe(false);
    expect(hasCustomRequestContext(request)).toBe(true);
    const plain = scrapeRequestSchema.parse({ url: "https://example.com" });
    expect(applyScrapeOptionsDefaults(plain).skipTlsVerification).toBe(true);
    expect(hasCustomRequestContext(plain)).toBe(false);
    expect(
      redactRequestBodyForLog({
        session_id: "private-capability",
        headers: { "x-browser-handoff": "private-ticket" },
      }),
    ).toEqual({
      session_id: "[REDACTED]",
      headers: { "x-browser-handoff": "[REDACTED]" },
    });
  });
  it("rejects unsupported actions, empty predicates and ambiguous combinations before execution", () => {
    for (const input of [
      { browserControls: { readiness: {} } },
      {
        browserControls: { workflow: "auto" },
        actions: [{ type: "click", selector: "button" }],
      },
      {
        browserControls: {},
        actions: [{ type: "executeJavascript", script: "1+1" }],
      },
      { browserControls: { sessionId: randomUUID(), maxAttempts: 2 } },
      { browserControls: {}, formats: ["screenshot"] },
      { browserControls: {}, lockdown: true },
    ])
      expect(
        scrapeRequestSchema.safeParse({ url: "https://example.com", ...input })
          .success,
      ).toBe(false);
    expect(
      scrapeRequestSchema.safeParse({
        url: "https://example.com",
        actions: [{ type: "executeJavascript", script: "1+1" }],
      }).success,
    ).toBe(true);
  });
  it("permits stateless controls in batch/crawl but excludes a shared mutable session", () => {
    expect(
      batchScrapeRequestSchema.safeParse({
        urls: ["https://example.com"],
        browserControls: { consent: "off" },
      }).success,
    ).toBe(true);
    expect(
      batchScrapeRequestSchema.safeParse({
        urls: ["https://example.com"],
        browserControls: { sessionId: randomUUID() },
      }).success,
    ).toBe(false);
    expect(
      crawlRequestSchema.safeParse({
        url: "https://example.com",
        scrapeOptions: { browserControls: { sessionId: randomUUID() } },
      }).success,
    ).toBe(false);
  });
});
