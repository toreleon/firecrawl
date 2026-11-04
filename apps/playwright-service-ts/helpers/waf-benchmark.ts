import { createHash } from 'node:crypto';
import { detectBotChallenge } from './bot-detection';

export interface WafTarget {
  name: string;
  url: string;
  containsText: string;
  antibot?: string;
  industry?: string;
}

export interface ScrapeObservation {
  apiStatus: number;
  body: Record<string, unknown>;
  transportError?: string;
  timedOut?: boolean;
}

// This is a supplementary text-content screen, not a CSS visibility engine.
export const textContent = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(?:nbsp|amp|quot|apos|lt|gt);/gi,
      (entity) =>
        ({
          '&nbsp;': ' ',
          '&amp;': '&',
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
        })[entity.toLowerCase()] ?? entity,
    )
    .replace(/\s+/g, ' ')
    .trim();

export const scoreObservation = (
  target: WafTarget,
  observation: ScrapeObservation,
) => {
  const content =
    typeof observation.body.content === 'string'
      ? observation.body.content
      : '';
  const pageStatus =
    typeof observation.body.pageStatusCode === 'number'
      ? observation.body.pageStatusCode
      : null;
  const apiOk = observation.apiStatus >= 200 && observation.apiStatus < 300;
  const pageOk = pageStatus !== null && pageStatus >= 200 && pageStatus < 300;
  const rawMarkerPresent = content
    .toLowerCase()
    .includes(target.containsText.toLowerCase());
  const expectedText = textContent(target.containsText).toLowerCase();
  const textMarkerPresent =
    expectedText.length > 0 &&
    textContent(content).toLowerCase().includes(expectedText);
  const frontierPass =
    apiOk && pageOk && rawMarkerPresent && !observation.transportError;
  const challenge =
    observation.body.botDetection ?? detectBotChallenge(content);
  const pageError =
    typeof observation.body.pageError === 'string'
      ? observation.body.pageError
      : undefined;
  let failureReason: string | undefined;
  if (observation.transportError)
    failureReason = observation.timedOut ? 'timeout' : 'transport_error';
  else if (observation.body.errorCode === 'SCRAPE_TIMEOUT')
    failureReason = 'timeout';
  else if (observation.body.errorCode === 'NETWORK_ERROR')
    failureReason = 'network_error';
  else if (!apiOk) failureReason = 'service_error';
  else if (challenge) failureReason = 'challenge';
  else if (pageStatus === 429) failureReason = 'rate_limited';
  else if (pageStatus === 404 || pageStatus === 410)
    failureReason = 'target_unavailable';
  else if (!pageOk) failureReason = `target_status_${pageStatus ?? 'missing'}`;
  else if (observation.body.errorCode === 'CONTENT_NOT_READY')
    failureReason = 'content_not_ready';
  else if (pageError) failureReason = 'page_error';
  else if (!rawMarkerPresent) failureReason = 'missing_expected_marker';
  else if (!textMarkerPresent)
    failureReason = 'marker_only_in_noncontent_markup';
  return {
    frontierPass,
    screenedPass: frontierPass && !failureReason,
    // Independent of the legacy raw-HTML assertion. Keep all three metrics;
    // this does not establish CSS visibility or full-page correctness.
    normalizedPass:
      apiOk &&
      pageOk &&
      textMarkerPresent &&
      !observation.transportError &&
      !challenge &&
      !pageError &&
      !observation.body.errorCode,
    serviceAttemptCount: Array.isArray(
      (observation.body.diagnostics as Record<string, unknown> | undefined)
        ?.attempts,
    )
      ? (observation.body.diagnostics as { attempts: unknown[] }).attempts
          .length
      : undefined,
    failureReason,
    apiStatus: observation.apiStatus,
    pageStatus,
    rawMarkerPresent,
    textMarkerPresent,
    pageError,
    transportError: observation.transportError,
    landedUrl:
      typeof observation.body.url === 'string'
        ? observation.body.url
        : undefined,
    title: content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim(),
    contentBytes: Buffer.byteLength(content),
    contentSha256: createHash('sha256').update(content).digest('hex'),
  };
};

export type WafAttempt = ReturnType<typeof scoreObservation> & {
  target: string;
  url: string;
  wafLabel: string;
  attempt: number;
  startedAt: string;
  latencyMs: number;
  evidenceFile?: string;
};

const percentile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
};

export const summarizeAttempts = (attempts: WafAttempt[]) => {
  const summarize = (rows: WafAttempt[]) => ({
    requests: rows.length,
    uniqueTargets: new Set(rows.map((row) => row.target)).size,
    frontierPasses: rows.filter((row) => row.frontierPass).length,
    screenedPasses: rows.filter((row) => row.screenedPass).length,
    normalizedPasses: rows.filter((row) => row.normalizedPass).length,
    frontierSuccessRate: rows.length
      ? rows.filter((row) => row.frontierPass).length / rows.length
      : null,
    screenedSuccessRate: rows.length
      ? rows.filter((row) => row.screenedPass).length / rows.length
      : null,
    normalizedSuccessRate: rows.length
      ? rows.filter((row) => row.normalizedPass).length / rows.length
      : null,
    successfulLatencyP50Ms: percentile(
      rows.filter((row) => row.screenedPass).map((row) => row.latencyMs),
      0.5,
    ),
    successfulLatencyP95Ms: percentile(
      rows.filter((row) => row.screenedPass).map((row) => row.latencyMs),
      0.95,
    ),
    allAttemptLatencyP95Ms: percentile(
      rows.map((row) => row.latencyMs),
      0.95,
    ),
    failures: rows.reduce<Record<string, number>>((counts, row) => {
      if (row.failureReason)
        counts[row.failureReason] = (counts[row.failureReason] ?? 0) + 1;
      return counts;
    }, {}),
  });
  return {
    overall: summarize(attempts),
    byWafLabel: Object.fromEntries(
      [...new Set(attempts.map((row) => row.wafLabel))]
        .sort()
        .map((label) => [
          label,
          summarize(attempts.filter((row) => row.wafLabel === label)),
        ]),
    ),
  };
};

export const requestScrape = async (
  serviceUrl: string,
  target: WafTarget,
  timeoutMs: number,
  waitMs: number,
  options: Record<string, unknown> = {},
  serviceTimeoutMs?: number,
): Promise<ScrapeObservation> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let apiStatus = 0;
  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...options,
        url: target.url,
        timeout:
          serviceTimeoutMs ??
          Math.max(1, timeoutMs - waitMs - Math.min(5000, timeoutMs / 10)),
        wait_after_load: waitMs,
      }),
      signal: controller.signal,
    });
    apiStatus = response.status;
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Invalid browser-service JSON response object');
    }
    return { apiStatus, body: body as Record<string, unknown> };
  } catch (error) {
    return {
      apiStatus,
      body: {},
      transportError: String(error),
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
};
