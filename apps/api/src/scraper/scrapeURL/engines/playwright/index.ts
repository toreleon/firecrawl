import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { scrapeLocalBrowser } from "../../../../lib/local-browser/client";
import { LocalBrowserError } from "../../../../lib/local-browser/store";
import { LocalBrowserTransportError } from "../../../../lib/error";

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  if (
    meta.options.browserControls?.sessionId &&
    meta.internalOptions.zeroDataRetention
  )
    throw new LocalBrowserTransportError(
      "SESSION_ZDR_UNSUPPORTED",
      "Durable browser sessions are unavailable with zero data retention",
      400,
    );
  let localResponse: any;
  if (meta.options.browserControls) {
    const remaining = Math.min(
      meta.abort.scrapeTimeout() ?? 30000,
      meta.internalOptions.browserDeadlineAt === undefined
        ? Infinity
        : meta.internalOptions.browserDeadlineAt - Date.now(),
    );
    if (remaining < 100)
      throw new LocalBrowserTransportError(
        "SCRAPE_TIMEOUT",
        "Browser execution deadline expired",
        408,
      );
    try {
      localResponse = await scrapeLocalBrowser(
        meta.internalOptions.teamId,
        meta.id,
        {
          url: meta.rewrittenUrl ?? meta.url,
          timeout: remaining,
          waitFor: meta.options.waitFor,
          controls: meta.options.browserControls,
          headers: meta.options.headers,
          blockAds: meta.options.blockAds,
          skipTlsVerification: meta.options.skipTlsVerification,
          actions: meta.options.actions,
          signal: meta.abort.asSignal(),
        },
      );
    } catch (error) {
      if (error instanceof LocalBrowserError)
        throw new LocalBrowserTransportError(
          error.code,
          error.message,
          error.status,
        );
      throw error;
    }
  }
  const response =
    localResponse ??
    (await robustFetch({
      url: config.PLAYWRIGHT_MICROSERVICE_URL!,
      headers: {
        "Content-Type": "application/json",
        ...(config.BROWSER_SERVICE_AUTH_TOKEN
          ? { authorization: `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}` }
          : {}),
      },
      body: {
        url: meta.rewrittenUrl ?? meta.url,
        wait_after_load: meta.options.waitFor,
        timeout: meta.abort.scrapeTimeout(),
        headers: meta.options.headers,
        skip_tls_verification: meta.options.skipTlsVerification,
      },
      method: "POST",
      logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
      schema: z.object({
        content: z.string(),
        pageStatusCode: z.number(),
        pageError: z.string().optional(),
        contentType: z.string().optional(),
        // Optional: older playwright-service builds don't send it.
        url: z.string().optional(),
      }),
      mock: meta.mock,
      abort: meta.abort.asSignal(),
    }));

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    // The landed URL reported by the service. Redirect threat and blocklist
    // re-checks compare it against the requested URL. Falls back to the
    // requested URL for older services or a non-http(s) value (about:blank).
    url: landedHttpUrl(response.url) ?? meta.rewrittenUrl ?? meta.url,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    ...(localResponse
      ? {
          actions: localResponse.actions,
          browser: {
            readiness: localResponse.readiness,
            interaction: localResponse.interaction,
            diagnostics: localResponse.diagnostics,
            errorCode: localResponse.errorCode,
            ...(localResponse.publicSessionId
              ? { sessionId: localResponse.publicSessionId }
              : {}),
          },
        }
      : {}),

    proxyUsed: "basic",
  };
}

function landedHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + 30000;
}
