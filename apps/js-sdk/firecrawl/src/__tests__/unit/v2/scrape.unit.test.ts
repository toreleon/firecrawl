import { describe, test, expect } from "vitest";
import axios, { type AxiosAdapter } from "axios";
import { FirecrawlClient } from "../../../v2/client";

const API_URL = "https://api.firecrawl.dev";

function makeClient(apiKey: string) {
  const client = new FirecrawlClient({ apiKey, apiUrl: API_URL });
  const sent: Array<{ method?: string; url: string; authorization: unknown; body: unknown }> = [];
  const adapter: AxiosAdapter = async config => {
    sent.push({
      method: config.method,
      url: axios.getUri(config),
      authorization: config.headers.Authorization,
      body: JSON.parse(config.data),
    });
    return {
      data: { success: true, data: { markdown: "# hello" } },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  (client as any).http.instance.defaults.adapter = adapter;
  return { client, sent };
}

describe("v2.scrape unit", () => {
  test("forwards local browser controls without changing nested session/readiness values", async () => {
    const {client,sent}=makeClient("fc-test");
    const browserControls={waitUntil:"domcontentloaded" as const,readiness:{selector:"main",text:"Company 42",timeoutMs:3000},consent:"rejectNonEssential" as const,sessionId:"f63d36ec-882e-4b56-a663-68678c905cb6",continueSession:true};
    await client.scrape("https://example.com",{browserControls});
    expect((sent[0]!.body as any).browserControls).toEqual(browserControls);
  });
  test("constructs without an API key and scrapes keyless, without an Authorization header", async () => {
    const { client, sent } = makeClient("");
    const doc = await client.scrape(" https://example.com ", { formats: ["markdown"] });

    expect(doc.markdown).toBe("# hello");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("post");
    expect(sent[0]!.url).toBe(`${API_URL}/v2/scrape`);
    expect(sent[0]!.authorization).toBeUndefined();
    expect(sent[0]!.body).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
      origin: expect.stringMatching(/^js-sdk@/),
    });
  });

  test("sends the API key as a bearer token when one is set", async () => {
    const { client, sent } = makeClient("fc-test");
    await client.scrape("https://example.com");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.authorization).toBe("Bearer fc-test");
  });

  test("rejects an empty URL before sending a request", async () => {
    const { client, sent } = makeClient("fc-test");

    await expect(client.scrape("  ")).rejects.toThrow("URL cannot be empty");
    expect(sent).toHaveLength(0);
  });
});
