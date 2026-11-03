import { createHash } from 'node:crypto';
import { ScrapeObservation, textContent } from './waf-benchmark';

export type ApiProfile = {
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  minIntervalMs?: number;
  // Fork-only controls are explicit in the receipt; never sent to Cloud.
  browserControls?: Record<string, unknown>;
};

export const validateProfiles = (value: unknown): ApiProfile[] => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8)
    throw new Error('Expected 2..8 API profiles');
  const names = new Set<string>();
  for (const p of value) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).some(
        (k) =>
          ![
            'name',
            'baseUrl',
            'apiKeyEnv',
            'minIntervalMs',
            'browserControls',
          ].includes(k),
      ) ||
      typeof p.name !== 'string' ||
      !/^[a-z0-9_-]{1,64}$/i.test(p.name) ||
      names.has(p.name) ||
      typeof p.baseUrl !== 'string'
    )
      throw new Error('Invalid or duplicate API profile');
    names.add(p.name);
    const url = new URL(p.baseUrl);
    if (
      (p.minIntervalMs !== undefined &&
        (!Number.isInteger(p.minIntervalMs) ||
          p.minIntervalMs < 0 ||
          p.minIntervalMs > 60000)) ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (p.apiKeyEnv !== undefined &&
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(p.apiKeyEnv)) ||
      (p.apiKeyEnv &&
        url.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      (p.browserControls !== undefined &&
        (!p.browserControls ||
          typeof p.browserControls !== 'object' ||
          Array.isArray(p.browserControls)))
    )
      throw new Error('Invalid API endpoint or credentials configuration');
  }
  return value as ApiProfile[];
};

/** Serialize dispatch reservations per profile, shared by all workers. */
export class ProfilePacer {
  private tails = new Map<string, Promise<void>>();
  private last = new Map<string, number>();
  async wait(profile: ApiProfile) {
    if (!profile.minIntervalMs) return 0;
    const now = Date.now();
    const turn = (this.tails.get(profile.name) ?? Promise.resolve()).then(
      async () => {
        const slot = Math.max(
          Date.now(),
          (this.last.get(profile.name) ?? 0) + (profile.minIntervalMs ?? 0),
        );
        while (Date.now() < slot)
          await new Promise((resolve) =>
            setTimeout(resolve, slot - Date.now()),
          );
        this.last.set(profile.name, Date.now());
      },
    );
    this.tails.set(profile.name, turn);
    await turn;
    return Date.now() - now;
  }
}

export const redact = (value: unknown, secrets: string[]): string => {
  let serialized = JSON.stringify(value, null, 2);
  for (const secret of secrets.filter(Boolean))
    serialized = serialized.split(secret).join('[REDACTED]');
  return serialized;
};

export const normalizeApiResponse = (
  apiStatus: number,
  payload: unknown,
): ScrapeObservation => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return {
      apiStatus,
      body: { pageError: 'Invalid Firecrawl response object' },
    };
  const response = payload as any;
  const data =
    response.data && typeof response.data === 'object' ? response.data : {};
  const meta =
    data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  return {
    apiStatus,
    body: {
      // HTML is the only input to the legacy/screened/normalized HTML grader.
      // Missing rawHtml is a failure, never replaced by Markdown or metadata.
      content: typeof data.rawHtml === 'string' ? data.rawHtml : '',
      pageStatusCode:
        typeof meta.statusCode === 'number' ? meta.statusCode : null,
      ...((meta.browser?.errorCode ||
        ['NETWORK_ERROR', 'SCRAPE_TIMEOUT'].includes(response.code)) && {
        errorCode: meta.browser?.errorCode ?? response.code,
      }),
      ...((response.success !== true || meta.error) && {
        pageError: String(
          response.error ?? meta.error ?? 'API did not report success',
        ),
      }),
    },
  };
};

export const apiOutputMetrics = (payload: any, expected: string) => {
  const data = payload?.data;
  const meta = data?.metadata;
  const markdown = typeof data?.markdown === 'string' ? data.markdown : '';
  const marker = textContent(expected).toLowerCase();
  const credits = meta?.creditsUsed;
  return {
    apiSuccess: payload?.success === true,
    rawHtmlReturned: typeof data?.rawHtml === 'string',
    markdownChars: markdown.length,
    // A supplementary marker check, not extraction recall/precision/F1.
    markdownMarkerPresent:
      marker.length > 0 && textContent(markdown).toLowerCase().includes(marker),
    creditsUsed:
      typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
        ? credits
        : null,
    cacheState:
      typeof meta?.cacheState === 'string'
        ? meta.cacheState.slice(0, 100)
        : 'not_reported',
    sourceUrl: typeof meta?.sourceURL === 'string' ? meta.sourceURL : null,
  };
};

export const apiRequestBody = (
  profile: ApiProfile,
  url: string,
  timeoutMs: number,
) => ({
  url,
  formats: ['rawHtml', 'markdown'],
  onlyMainContent: false,
  maxAge: 0,
  storeInCache: false,
  waitFor: 0,
  timeout: Math.max(1, timeoutMs - Math.min(5000, timeoutMs / 10)),
  ...(profile.browserControls && { browserControls: profile.browserControls }),
});

export const requestApiScrape = async (
  profile: ApiProfile,
  url: string,
  timeoutMs: number,
  apiKey?: string,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let apiStatus = 0;
  try {
    const response = await fetch(
      `${profile.baseUrl.replace(/\/$/, '')}/v2/scrape`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey && { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(apiRequestBody(profile, url, timeoutMs)),
        signal: controller.signal,
        // Never forward a benchmark credential to a redirected endpoint.
        redirect: 'error',
      },
    );
    apiStatus = response.status;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    let length = 0;
    if (reader) {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > 20 * 1024 * 1024) {
          await reader.cancel();
          return {
            observation: {
              apiStatus,
              body: { pageError: 'Response exceeded 20 MiB evidence limit' },
            },
            payload: null,
          };
        }
        chunks.push(item.value);
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {
        observation: {
          apiStatus,
          body: { pageError: 'Invalid JSON API response' },
        },
        payload: null,
      };
    }
    return { observation: normalizeApiResponse(apiStatus, payload), payload };
  } catch (error) {
    return {
      observation: {
        apiStatus,
        body: {},
        transportError: String(error),
        timedOut: controller.signal.aborted,
      },
      payload: null,
    };
  } finally {
    clearTimeout(timer);
  }
};

export const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
