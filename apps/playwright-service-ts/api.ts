import express, { Request, Response } from 'express';
import {
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
} from 'playwright';
import dotenv from 'dotenv';
import { getError } from './helpers/get_error';
import { Server } from 'proxy-chain';
import { isInternalHost, ssrfPrepareRequest } from './helpers/ssrf';
import { browserConfiguration, launchBrowser } from './helpers/browser';
import { detectBotChallenge } from './helpers/bot-detection';
import { cookieScope } from './helpers/cookies';
import {
  Deadline,
  Semaphore,
  ScrapeFailure,
  errorCode,
  retryAfterMs,
  boundedClose,
} from './helpers/scrape-control';
import { scrapePage } from './helpers/scrape-page';
import { BrowserSessions } from './helpers/browser-sessions';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BrowserAction,
  ConsentPolicy,
  Workflow,
  validActions,
  workflowIds,
  actionTypes,
  interactionState,
  handoffKeys,
} from './helpers/workflows';

dotenv.config();
const browserConfig = browserConfiguration();

const app = express();
const ownerBootId = randomUUID();
const port = process.env.PORT || 3003;

app.use(express.json());
app.use((req, res, next) => {
  const expected = process.env.BROWSER_SERVICE_AUTH_TOKEN;
  const actual = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (
    expected &&
    (Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual)))
  )
    return res.status(401).json({
      errorCode: 'UNAUTHORIZED',
      error: 'Internal browser authentication required',
    });
  if (
    req.headers['x-browser-owner'] &&
    req.headers['x-browser-owner'] !== ownerBootId
  )
    return res.status(409).json({
      errorCode: 'SESSION_LOST',
      error: 'Browser owner process changed',
    });
  next();
});

const BLOCK_MEDIA =
  (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
const BLOCK_ADS = (process.env.BLOCK_ADS ?? 'true').toLowerCase() === 'true';
const MAX_CONCURRENT_PAGES = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? '10', 10) || 10,
);
const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

const assertSafeTargetUrl = async (urlString: string): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }
  if (!ALLOW_LOCAL_WEBHOOKS && (await isInternalHost(parsedUrl.hostname))) {
    throw new InsecureConnectionError(
      urlString,
      'resolves to a private/internal address',
    );
  }
};

const buildUpstreamProxyUrl = (): string | undefined => {
  if (!PROXY_SERVER) return undefined;
  const server = PROXY_SERVER.includes('://')
    ? PROXY_SERVER
    : `http://${PROXY_SERVER}`;
  const url = new URL(server);
  if (PROXY_USERNAME) url.username = PROXY_USERNAME;
  if (PROXY_PASSWORD) url.password = PROXY_PASSWORD;
  return url.toString();
};

const startSSRFProxy = async (): Promise<number> => {
  const server = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: ssrfPrepareRequest({
      allowLocal: ALLOW_LOCAL_WEBHOOKS,
      upstreamProxyUrl: buildUpstreamProxyUrl(),
    }),
  });
  await server.listen();
  ssrfProxy = server;
  return server.port;
};

let ssrfProxyPort: number;
let ssrfProxy: Server;

type ContextSecurityState = {
  blockedNavigationRequestUrl: string | null;
  blockedRequests: { ads: number; media: number; private: number };
};
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
  wait_until?: 'load' | 'domcontentloaded';
  wait_for_text?: string;
  readiness_timeout?: number;
  max_attempts?: number;
  create_session?: boolean;
  session_id?: string;
  session_mode?: 'context' | 'workflow';
  continue_session?: boolean;
  readiness_scope?: 'body' | 'title';
  consent?: ConsentPolicy;
  workflow?: Workflow;
  actions?: BrowserAction[];
  block_ads?: boolean;
  operation_revision?: number;
}

let browser: Browser;
let browserLaunch: Promise<Browser> | undefined;

const initializeBrowser = async () => {
  if (browser?.isConnected()) return;
  browserLaunch ??= launchBrowser(browserConfig);
  try {
    browser = await browserLaunch;
  } finally {
    browserLaunch = undefined;
  }
};

const createContext = async (
  skipTlsVerification: boolean = false,
  userAgentOverride?: string,
  blockAds = BLOCK_ADS,
  workflowOrigin?: string,
): Promise<{
  context: BrowserContext;
  securityState: ContextSecurityState;
  workflowPage?: Page;
}> => {
  const securityState: ContextSecurityState = {
    blockedNavigationRequestUrl: null,
    blockedRequests: { ads: 0, media: 0, private: 0 },
  };

  const contextOptions: any = {
    // Keep the browser's native UA/platform/client hints coherent. A random
    // mobile or Safari UA on desktop Chromium is itself a detection signal.
    ...(userAgentOverride ? { userAgent: userAgentOverride } : {}),
    viewport: null,
    ignoreHTTPSErrors: skipTlsVerification,
    serviceWorkers: 'block',
  };

  contextOptions.proxy = {
    server: `http://127.0.0.1:${ssrfProxyPort}`,
  };

  const newContext = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await newContext.route(
      '**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}',
      async (route: Route, request: PlaywrightRequest) => {
        securityState.blockedRequests.media++;
        await route.abort();
      },
    );
  }

  // Intercept all requests to avoid loading ads
  await newContext.route(
    '**/*',
    async (route: Route, request: PlaywrightRequest) => {
      const requestUrlString = request.url();
      try {
        await assertSafeTargetUrl(requestUrlString);
      } catch (error) {
        if (error instanceof InsecureConnectionError) {
          securityState.blockedRequests.private++;
          if (
            request.isNavigationRequest() &&
            request.frame().parentFrame() === null
          ) {
            securityState.blockedNavigationRequestUrl = requestUrlString;
          }
          console.warn(`Blocked request: ${requestUrlString}`);
          return route.abort('blockedbyclient');
        }
        throw error;
      }

      const hostname = new URL(requestUrlString).hostname.toLowerCase();

      if (
        workflowOrigin &&
        request.isNavigationRequest() &&
        request.frame().parentFrame() === null &&
        new URL(requestUrlString).origin !== workflowOrigin
      )
        return route.abort('blockedbyclient');

      if (
        blockAds &&
        AD_SERVING_DOMAINS.some(
          (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
        )
      ) {
        securityState.blockedRequests.ads++;
        console.log(hostname);
        return route.abort();
      }
      return route.continue();
    },
  );

  return { context: newContext, securityState };
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const sessions = new BrowserSessions(
  async (profile: string) => {
    const { skipTlsVerification, userAgentOverride, blockAds, workflowOrigin } =
      JSON.parse(profile);
    return createContext(
      skipTlsVerification,
      userAgentOverride,
      blockAds,
      workflowOrigin,
    );
  },
  async (bundle) => {
    await boundedClose(bundle.context.close());
  },
  Math.max(1, Math.min(128, Number(process.env.MAX_BROWSER_SESSIONS) || 8)),
  Math.max(
    100,
    Math.min(1800000, Number(process.env.BROWSER_SESSION_TTL_MS) || 300000),
  ),
);
const sessionJanitor = setInterval(() => {
  sessions
    .sweep()
    .catch((error) => console.error('Session cleanup failed:', error));
}, 1000);
sessionJanitor.unref();

app.delete('/sessions/:token', async (req: Request, res: Response) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(req.params.token as string))
      return res.status(400).json({ error: 'Invalid session token' });
    const removed = await sessions.remove(req.params.token as string);
    return res.status(removed ? 204 : 404).end();
  } catch (error) {
    return res
      .status(409)
      .json({ error: 'Session is busy', errorCode: errorCode(error) });
  }
});

const sessionPageOperation = async (
  req: Request,
  res: Response,
  run: (page: Page) => Promise<unknown>,
) => {
  const token = req.params.token as string;
  const revisionHeader = req.headers['x-operation-revision'];
  const revision =
    revisionHeader === undefined ? undefined : Number(revisionHeader);
  if (
    !/^[a-f0-9]{64}$/.test(token) ||
    (revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision < 1))
  )
    return res.status(400).json({ errorCode: 'INVALID_OPTIONS' });
  try {
    const result = await sessions.use(
      token,
      async (bundle) => {
        if (!bundle.workflowPage || bundle.workflowPage.isClosed())
          throw new ScrapeFailure(
            'SESSION_LOST',
            'Retained tab is unavailable',
          );
        return new Deadline(5000).run(run(bundle.workflowPage));
      },
      revision,
    );
    res.json(result);
  } catch (error) {
    res
      .status(409)
      .json({ errorCode: errorCode(error), error: 'Session operation failed' });
  }
};
app.get('/sessions/:token/snapshot', async (req, res) =>
  sessionPageOperation(req, res, async (page) => {
    const image = await page.screenshot({
      type: 'jpeg',
      quality: 65,
      timeout: 4000,
    });
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    return { image: image.toString('base64'), ...viewport, url: page.url() };
  }),
);
app.post('/sessions/:token/input', async (req, res) => {
  const input = req.body;
  if (
    !input ||
    !['click', 'key', 'text'].includes(input.type) ||
    (input.type === 'click' &&
      ![input.x, input.y].every(
        (n) => Number.isFinite(n) && n >= 0 && n <= 10000,
      )) ||
    (input.type === 'key' && !handoffKeys.includes(input.key)) ||
    (input.type === 'text' &&
      (typeof input.text !== 'string' || input.text.length > 1024))
  )
    return res.status(400).json({ errorCode: 'INVALID_OPTIONS' });
  return sessionPageOperation(req, res, async (page) => {
    if (input.type === 'click') {
      const size = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      if (input.x >= size.width || input.y >= size.height)
        throw new ScrapeFailure('INVALID_OPTIONS', 'Click outside viewport');
      await page.mouse.click(input.x, input.y);
    }
    if (input.type === 'key') await page.keyboard.press(input.key);
    if (input.type === 'text') await page.keyboard.insertText(input.text);
    return { success: true };
  });
});

app.get('/health', async (req: Request, res: Response) => {
  try {
    if (!browser) {
      await initializeBrowser();
    }

    const { context: testContext } = await createContext();
    const testPage = await testContext.newPage();
    await testPage.close();
    await testContext.close();

    res.status(200).json({
      status: 'healthy',
      browserEngine: browserConfig.engine,
      headless: browserConfig.launchOptions.headless,
      maxConcurrentPages: MAX_CONCURRENT_PAGES,
      activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits(),
      browserSessions: sessions.size,
      blockAds: BLOCK_ADS,
      ownerBootId,
      capabilities: {
        version: 1,
        readiness: true,
        actions: actionTypes,
        workflows: workflowIds,
        consent: true,
        retainedPages: true,
        fencedSessions: true,
        pageScopedHandoff: true,
      },
      serviceWorkers: 'block',
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

app.post('/scrape', async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 15000,
    headers,
    check_selector,
    skip_tls_verification = false,
    wait_until = 'load',
    wait_for_text,
    readiness_timeout = 5000,
    max_attempts = 1,
    create_session = false,
    session_id,
    session_mode = 'context',
    continue_session = false,
    readiness_scope = 'body',
    consent = 'off',
    workflow = 'none',
    actions = [],
    block_ads = BLOCK_ADS,
    operation_revision,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(
    `Header names: ${headers ? Object.keys(headers).join(', ') : 'None'}`,
  );
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`Skip TLS Verification: ${skip_tls_verification}`);
  console.log(`==================================================`);

  if (
    !Number.isInteger(timeout) ||
    timeout < 100 ||
    timeout > 120000 ||
    !Number.isInteger(wait_after_load) ||
    wait_after_load < 0 ||
    wait_after_load >= timeout ||
    !Number.isInteger(readiness_timeout) ||
    readiness_timeout < 1 ||
    readiness_timeout > 120000 ||
    !Number.isInteger(max_attempts) ||
    max_attempts < 1 ||
    max_attempts > 3 ||
    !['load', 'domcontentloaded'].includes(wait_until) ||
    typeof skip_tls_verification !== 'boolean' ||
    typeof create_session !== 'boolean' ||
    (wait_for_text !== undefined &&
      (typeof wait_for_text !== 'string' ||
        !wait_for_text.trim() ||
        wait_for_text.length > 2048)) ||
    (check_selector !== undefined &&
      (typeof check_selector !== 'string' || check_selector.length > 2048)) ||
    (session_id !== undefined &&
      (typeof session_id !== 'string' || !/^[a-f0-9]{64}$/.test(session_id))) ||
    (create_session && session_id) ||
    !['context', 'workflow'].includes(session_mode) ||
    !['body', 'title'].includes(readiness_scope) ||
    !['off', 'rejectNonEssential', 'acceptAll'].includes(consent) ||
    !workflowIds.includes(workflow) ||
    typeof block_ads !== 'boolean' ||
    typeof continue_session !== 'boolean' ||
    !validActions(actions) ||
    (actions.length > 0 && workflow !== 'none') ||
    ((session_mode === 'workflow' || actions.length > 0) &&
      max_attempts !== 1) ||
    (continue_session && (!session_id || session_mode !== 'workflow')) ||
    (session_mode === 'workflow' && !session_id && !create_session) ||
    (operation_revision !== undefined &&
      (!Number.isSafeInteger(operation_revision) || operation_revision < 1)) ||
    (headers !== undefined &&
      (!headers ||
        typeof headers !== 'object' ||
        Array.isArray(headers) ||
        Object.values(headers).some((value) => typeof value !== 'string')))
  ) {
    return res
      .status(400)
      .json({ error: 'Invalid scrape options', errorCode: 'INVALID_OPTIONS' });
  }
  const requestStarted = Date.now();
  const cancellation = new AbortController();
  const deadline = new Deadline(timeout, cancellation.signal);
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    await deadline.run(assertSafeTargetUrl(url));
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    return res
      .status(500)
      .json({ error: 'Target validation failed', errorCode: errorCode(error) });
  }

  if (!PROXY_SERVER) {
    console.warn(
      '⚠️ WARNING: No proxy server provided. Your IP address may be blocked.',
    );
  }

  if (!browser?.isConnected()) {
    await initializeBrowser();
  }

  let permit = false;
  let sessionToken: string | undefined;
  let sessionExpiresAt: number | undefined;
  let succeeded = false;
  let cleanupHealthy = true;
  const attempts: Record<string, unknown>[] = [];

  let requestContext: BrowserContext | null = null;
  let securityState: ContextSecurityState | null = null;
  let page: Page | null = null;
  const disconnected = () => {
    if (res.writableEnded) return;
    cancellation.abort();
    if (page) void boundedClose(page.close());
  };
  res.once('close', disconnected);

  try {
    await pageSemaphore.acquire(deadline.remaining());
    permit = true;
    // Extract user-agent from request headers (case-insensitive) so it can
    // be applied at the context level.  Playwright ignores user-agent in
    // setExtraHTTPHeaders when the context already defines one (#2802).
    const userAgentOverride = headers
      ? Object.entries(headers).find(
          ([k]) => k.toLowerCase() === 'user-agent',
        )?.[1]
      : undefined;

    const profile = JSON.stringify({
      skipTlsVerification: skip_tls_verification,
      userAgentOverride,
      blockAds: block_ads,
      consent,
      sessionMode: session_mode,
      ...(session_mode === 'workflow'
        ? { workflowOrigin: new URL(url).origin }
        : {}),
    });
    const lease =
      create_session || session_id
        ? await deadline.run(
            sessions.acquire(
              new URL(url).origin,
              profile,
              session_id,
              operation_revision,
            ),
            async (late) => sessions.release(late.token, true),
          )
        : undefined;
    sessionToken = lease?.token;
    sessionExpiresAt = lease?.expiresAt;
    const contextBundle =
      lease?.value ??
      (await deadline.run(
        createContext(skip_tls_verification, userAgentOverride, block_ads),
        async (late) => late.context.close(),
      ));
    requestContext = contextBundle.context;
    securityState = contextBundle.securityState;
    securityState.blockedNavigationRequestUrl = null;
    securityState.blockedRequests = { ads: 0, media: 0, private: 0 };
    const filteredHeaders = headers
      ? Object.fromEntries(
          Object.entries(headers).filter(
            ([key]) => !['cookie', 'user-agent'].includes(key.toLowerCase()),
          ),
        )
      : {};

    if (headers) {
      // A Cookie header passed through setExtraHTTPHeaders is sent on the first
      // request but DROPPED on any redirect hop (the browser regenerates the
      // redirected request from its cookie jar, which is empty). Authenticated
      // sites that 302 (e.g. to /signin when the session looks absent) then
      // land on the login page. Seed the cookie jar instead so Chromium re-sends
      // it on every request, including redirects — matching what a raw HTTP
      // client does.
      const cookieHeader = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'cookie',
      )?.[1];
      if (cookieHeader) {
        // Scope cookies to the registrable domain (e.g. ".example.com"), not
        // host-only. Authenticated pages often 302 across sibling subdomains
        // (example.com -> app.example.com); a host-only cookie set for the
        // original host would not be sent to the redirect target, leaving the
        // request unauthenticated. The Cookie header carries no domain info, so
        // we apply the eTLD+1 — broad enough to follow the redirect, and these
        // are first-party cookies being returned to their own origin anyway.
        const scope = cookieScope(url);
        type SeedCookie = {
          name: string;
          value: string;
          url?: string;
          domain?: string;
          path?: string;
        };
        const cookies = cookieHeader
          .split(';')
          .map((pair) => pair.trim())
          .filter(Boolean)
          .map((pair): SeedCookie | null => {
            const eq = pair.indexOf('=');
            if (eq === -1) return null;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            return { name, value, ...scope };
          })
          .filter((c): c is SeedCookie => c !== null);
        if (cookies.length > 0) {
          try {
            await requestContext.addCookies(cookies);
          } catch (error) {
            console.warn('Failed to seed cookies from Cookie header:', error);
          }
        }
      }
    }

    let result: Awaited<ReturnType<typeof scrapePage>> | undefined;
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      const started = Date.now();
      const entry: Record<string, unknown> = { attempt };
      attempts.push(entry);
      let delay: number | null = null;
      try {
        if (
          session_mode === 'workflow' &&
          contextBundle.workflowPage?.isClosed()
        )
          throw new ScrapeFailure(
            'SESSION_LOST',
            'Retained tab was closed; create a new workflow',
          );
        page =
          session_mode === 'workflow' &&
          contextBundle.workflowPage &&
          !contextBundle.workflowPage.isClosed()
            ? contextBundle.workflowPage
            : await deadline.run(requestContext.newPage(), async (late) =>
                late.close(),
              );
        if (session_mode === 'workflow') contextBundle.workflowPage = page;
        await page.setExtraHTTPHeaders(filteredHeaders);
        const attemptDeadline = new Deadline(
          Math.max(
            1,
            Math.floor(deadline.remaining() / (max_attempts - attempt + 1)),
          ),
          cancellation.signal,
        );
        result = await scrapePage(
          page,
          url,
          {
            waitUntil: wait_until,
            waitAfterLoad: wait_after_load,
            checkSelector: check_selector,
            waitForText: wait_for_text,
            readinessTimeout: readiness_timeout,
            readinessScope: readiness_scope,
            consent,
            workflow,
            actions,
            continueSession: continue_session,
            retained: session_mode === 'workflow',
          },
          attemptDeadline,
        );
        entry.status = result.status;
        entry.durationMs = Date.now() - started;
        if (
          attempt < max_attempts &&
          !detectBotChallenge(result.content, result.headers) &&
          [429, 502, 503, 504].includes(result.status ?? 0)
        )
          delay =
            retryAfterMs(result.headers['retry-after']) ??
            250 * 2 ** (attempt - 1);
      } catch (error) {
        entry.errorCode = errorCode(error);
        entry.durationMs = Date.now() - started;
        if (securityState.blockedNavigationRequestUrl)
          throw new InsecureConnectionError(
            securityState.blockedNavigationRequestUrl,
            'navigation to private/internal resource is not allowed',
          );
        if (
          attempt >= max_attempts ||
          !/net::ERR_(?:CONNECTION_(?:CLOSED|RESET)|EMPTY_RESPONSE|TIMED_OUT)|Timeout/i.test(
            String(error),
          )
        )
          throw error;
        result = undefined;
        delay = 250 * 2 ** (attempt - 1);
      } finally {
        if (page && session_mode !== 'workflow') {
          cleanupHealthy = (await boundedClose(page.close())) && cleanupHealthy;
          page = null;
        }
      }
      if (delay === null) break;
      if (delay >= deadline.remaining()) {
        if (result) break;
        throw new ScrapeFailure('SCRAPE_TIMEOUT', 'No budget left for retry');
      }
      entry.retryDelayMs = delay;
      await deadline.sleep(delay);
    }
    if (!result)
      throw new ScrapeFailure('BROWSER_ERROR', 'No document was retrieved');
    if (check_selector && !result.readiness.satisfied)
      throw new ScrapeFailure(
        'CONTENT_NOT_READY',
        'Required selector did not become visible',
      );
    const botDetection = detectBotChallenge(
      result.content,
      result.headers ?? {},
    );
    const pageError = botDetection
      ? `Bot protection challenge remains (${botDetection.provider}): ${botDetection.reason}`
      : !result.readiness.satisfied
        ? 'Expected content did not become ready'
        : (getError(result.status) ?? undefined);

    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.status} ${pageError}`,
      );
    }

    succeeded = true;
    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      url: result.url,
      browserEngine: browserConfig.engine,
      readiness: result.readiness,
      renderedText: result.renderedText,
      actions: result.actions,
      interaction: {
        ...result.interaction,
        state: interactionState(
          result.renderedText,
          result.url,
          result.readiness.satisfied,
          result.status,
          !!botDetection,
        ),
      },
      diagnostics: {
        ...result.diagnostics,
        attempts,
        blockedRequests: securityState.blockedRequests,
        durationMs: Date.now() - requestStarted,
      },
      ...(sessionToken && { sessionId: sessionToken, sessionExpiresAt }),
      ...(!result.readiness.satisfied && { errorCode: 'CONTENT_NOT_READY' }),
      ...(botDetection && { botDetection }),
      ...(pageError && { pageError }),
    });
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    console.error('Scrape error:', error);
    const code = errorCode(error);
    const status =
      code === 'SESSION_LIMIT' ? 429 : code.startsWith('SESSION_') ? 409 : 500;
    res.status(status).json({
      error:
        error instanceof ScrapeFailure
          ? error.message
          : 'An error occurred while fetching the page.',
      errorCode: code,
      networkErrorCode: String(error).match(/net::(ERR_[A-Z_]+)/)?.[1],
      diagnostics: { attempts },
    });
  } finally {
    res.off('close', disconnected);
    if (sessionToken)
      await sessions
        .release(
          sessionToken,
          (!succeeded && (!session_id || session_mode === 'workflow')) ||
            !cleanupHealthy ||
            cancellation.signal.aborted,
        )
        .catch(() => {});
    else if (requestContext) await boundedClose(requestContext.close());
    if (permit) pageSemaphore.release();
  }
});

const start = async () => {
  ssrfProxyPort = await startSSRFProxy();
  await initializeBrowser();
  const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
  const shutdown = async () => {
    server.close();
    clearInterval(sessionJanitor);
    await sessions.close();
    await shutdownBrowser();
    await ssrfProxy.close(true);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown().then(
        () => process.exit(0),
        (error) => {
          console.error('Shutdown failed:', error);
          process.exit(1);
        },
      );
    });
  }
};
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
