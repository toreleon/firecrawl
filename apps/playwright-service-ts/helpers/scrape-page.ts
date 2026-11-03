import { Page, Response } from 'playwright';
import { createHash } from 'node:crypto';
import { Deadline, ScrapeFailure } from './scrape-control';
import {
  detectPageProtection,
  captureRenderedPage,
  renderedBodyState,
  waitForRenderedBody,
} from './page-readiness';
import {
  applyConsent,
  applyWorkflow,
  prepareConsent,
  runActions,
  ConsentPolicy,
  Workflow,
  BrowserAction,
  amazonProductIdentity,
} from './workflows';

export type ReadinessOptions = {
  waitUntil: 'load' | 'domcontentloaded';
  waitAfterLoad: number;
  checkSelector?: string;
  waitForText?: string;
  readinessTimeout: number;
  readinessScope?: 'body' | 'title';
  consent?: ConsentPolicy;
  workflow?: Workflow;
  actions?: BrowserAction[];
  continueSession?: boolean;
  retained?: boolean;
};
type DocumentState = {
  response: Response | null;
  revision: number;
  navigations: { url: string; status: number }[];
  failed: string[];
  phase: string;
};
const documents = new WeakMap<Page, DocumentState>();
const trackDocument = (page: Page) => {
  let state = documents.get(page);
  if (state) return state;
  state = {
    response: null,
    revision: 0,
    navigations: [],
    failed: [],
    phase: 'prepare',
  };
  documents.set(page, state);
  page.on('response', (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      state!.navigations.push({
        url: response.url(),
        status: response.status(),
      });
      if (response.status() < 300 || response.status() >= 400) {
        state!.response = response;
        state!.revision++;
      }
      if (state!.navigations.length > 200) state!.navigations.shift();
    }
  });
  page.on('requestfailed', (request) => {
    state!.failed.push(request.failure()?.errorText ?? 'unknown');
    if (state!.failed.length > 500) state!.failed.shift();
  });
  return state;
};

// Error paths cannot rely on evaluating a responsive renderer. Retain bounded
// network observations even when navigation fails before a DOM capture exists.
export const documentDiagnostics = (page: Page) => {
  const state = documents.get(page);
  return state
    ? {
        phase: state.phase,
        url: page.url(),
        lastResponseStatus: state.response?.status() ?? null,
        recentNavigations: state.navigations.slice(-20),
        recentFailedRequests: state.failed.slice(-30),
      }
    : undefined;
};

export const scrapePage = async (
  page: Page,
  url: string,
  options: ReadinessOptions,
  deadline: Deadline,
) => {
  const state = trackDocument(page);
  const navStart = state.navigations.length;
  const failStart = state.failed.length;
  const requestedAmazon = options.workflow === 'auto' ? amazonProductIdentity(url) : null;
  // Retained tabs use discovery-only injection; awaited explicit CMP controls
  // cannot leave a background consent click racing a later human handoff.
  await prepareConsent(page, options.consent ?? 'off', !options.retained);
  state.phase = 'navigation';
  if (!options.continueSession)
    await page.goto(url, {
      waitUntil: options.waitUntil,
      timeout: deadline.remaining(),
    });
  const originalProduct = requestedAmazon ? {
    asin: requestedAmazon,
    origin: amazonProductIdentity(page.url()) === requestedAmazon ? new URL(page.url()).origin : new URL(url).origin,
  } : undefined;
  state.phase = 'consent';
  const consent = await deadline.run(
    applyConsent(page, options.consent ?? 'off', deadline),
  );
  state.phase = 'workflow';
  const workflow = await deadline.run(
    applyWorkflow(page, options.workflow ?? 'none', deadline),
  );
  state.phase = 'actions';
  const actions = await deadline.run(
    runActions(page, options.actions ?? [], deadline),
  );
  if (options.actions?.length || workflow.steps.length)
    await deadline.run(applyConsent(page, options.consent ?? 'off', deadline));
  if (options.waitAfterLoad > 0) await deadline.sleep(options.waitAfterLoad);
  state.phase = 'readiness';
  const initialType = state.response?.headers()['content-type'] ?? '';
  const automaticRequested =
    options.workflow === 'auto' &&
    !options.checkSelector &&
    !options.waitForText &&
    !/application\/json|text\/plain|image\/|application\/pdf/i.test(
      initialType,
    );
  let passiveVerification = false;
  if (automaticRequested && state.response?.status() === 403) {
    try {
      const initial = await deadline.run(
        page.evaluate(captureRenderedPage, {}),
      );
      passiveVerification = !!detectPageProtection(
        initial.content,
        state.response?.headers(),
        initial.url,
      )?.passive;
    } catch (error) {
      // A passive script can commit its return navigation during this probe.
      // Recheck the current status below and let the capture revision guard
      // handle an in-flight document instead of failing the entire scrape.
      if (!/Execution context was destroyed|navigating/i.test(String(error)))
        throw error;
    }
  }
  const automatic =
    automaticRequested &&
    (passiveVerification ||
      ((state.response?.status() ?? 0) >= 200 &&
        (state.response?.status() ?? 0) < 300))
      ? await waitForRenderedBody(
          page,
          deadline,
          options.readinessTimeout,
          () => state.response?.headers() ?? {},
        )
      : undefined;
  let staticHttpError = false;
  const response = state.response;
  if (
    response &&
    response.status() >= 400 &&
    (options.checkSelector || options.waitForText)
  ) {
    const headers = response.headers();
    const length = headers['content-length'];
    const smallDocument = await deadline
      .run(
        page.evaluate(
          () => (document.documentElement?.outerHTML.length ?? 0) <= 16384,
        ),
      )
      .catch(() => false);
    if (
      !headers.refresh &&
      smallDocument &&
      (length === undefined || (Number(length) > 0 && Number(length) <= 16384))
    ) {
      const source = await deadline.run(response.body()).catch(() => null);
      // Inspect the original response, not a DOM from which a script may have
      // removed itself. Active error documents retain their readiness window.
      staticHttpError =
        !!source &&
        source.length <= 16384 &&
        !/<(?:script|iframe|frame|object|embed)\b|\bon[a-z]+\s*=|<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(
          source.toString('utf8'),
        ) &&
        response === state.response;
    }
  }
  const predicate = async () => {
    if (
      options.checkSelector &&
      !(await page.locator(options.checkSelector).first().isVisible())
    )
      return false;
    if (options.waitForText) {
      const actual = await page.evaluate(
        (scope) =>
          scope === 'title' ? document.title : (document.body?.innerText ?? ''),
        options.readinessScope,
      );
      if (
        !actual
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .includes(
            options.waitForText.toLowerCase().replace(/\s+/g, ' ').trim(),
          )
      )
        return false;
    }
    return true;
  };
  if ((options.checkSelector || options.waitForText) && !staticHttpError) {
    const end =
      Date.now() +
      Math.min(
        options.readinessTimeout,
        Math.max(1, deadline.remaining() - 300),
      );
    while (Date.now() < end) {
      if (
        await deadline.run(predicate()).catch((e) => {
          if (/Execution context was destroyed|navigating/i.test(String(e)))
            return false;
          throw e;
        })
      )
        break;
      await deadline.sleep(Math.min(100, Math.max(1, end - Date.now())));
    }
  }
  state.phase = 'capture';
  for (let attempt = 0; attempt < 5; attempt++) {
    deadline.remaining();
    const current = state.response;
    const revision = state.revision;
    const landedUrl = page.url();
    try {
      const snapshot = await deadline.run(
        page.evaluate(captureRenderedPage, {
          text: options.waitForText,
          selector: options.checkSelector,
          scope: options.readinessScope,
          automatic: !!automatic,
        }),
      );
      const selectorReady =
        !options.checkSelector ||
        (await deadline.run(
          page.locator(options.checkSelector).first().isVisible(),
        ));
      const headers = current ? await deadline.run(current.allHeaders()) : {};
      if (
        revision !== state.revision ||
        landedUrl !== page.url() ||
        snapshot.url !== landedUrl
      ) {
        await deadline.sleep(50);
        continue;
      }
      const expectedProduct = workflow.observations.amazonContinuation ?? originalProduct;
      if (expectedProduct) {
        const actualProduct = amazonProductIdentity(snapshot.url);
        if (
          new URL(snapshot.url).origin !== expectedProduct.origin ||
          (actualProduct !== null && actualProduct !== expectedProduct.asin) ||
          (actualProduct === null &&
            (current?.status() ?? 200) >= 200 &&
            (current?.status() ?? 200) < 300 &&
            !detectPageProtection(snapshot.content, headers, snapshot.url))
        )
          throw new ScrapeFailure(
            'WORKFLOW_NAVIGATION_MISMATCH',
            'Captured document is not the requested Amazon product',
          );
      }
      const contentType = headers['content-type'];
      const rawBody =
        contentType && /application\/json|text\/plain/i.test(contentType);
      const content =
        rawBody && current
          ? (await deadline.run(current.body())).toString('utf8')
          : snapshot.content;
      const automaticOutcome =
        automatic && !rawBody
          ? detectPageProtection(snapshot.content, headers, snapshot.url)
            ? 'verification'
            : snapshot.busyCount
              ? 'busy'
              : renderedBodyState(snapshot.renderedText)
          : undefined;
      const readinessSatisfied =
        rawBody && options.waitForText
          ? !options.checkSelector &&
            content
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .includes(
                options.waitForText.toLowerCase().replace(/\s+/g, ' ').trim(),
              )
          : snapshot.ready &&
            selectorReady &&
            (!automaticOutcome || automaticOutcome === 'ready');
      return {
        content,
        renderedText: snapshot.renderedText,
        url: rawBody && current ? current.url() : landedUrl,
        status: current?.status() ?? null,
        headers,
        contentType,
        actions,
        readiness: {
          requested: !!(options.checkSelector || options.waitForText),
          satisfied: readinessSatisfied,
          scope: options.readinessScope ?? 'body',
          documentRevision: revision,
          ...(automatic && {
            automatic: {
              ...automatic,
              busyCount: snapshot.busyCount,
              ignoredComplementaryBusyCount:
                snapshot.ignoredComplementaryBusyCount,
              busyScope: snapshot.busyScope,
              ...(automaticOutcome && { outcome: automaticOutcome }),
            },
          }),
        },
        interaction: { consent: { ...consent }, workflow },
        diagnostics: {
          ...(staticHttpError && { readinessWaitSkipped: 'static_http_error' }),
          navigations: state.navigations.slice(navStart),
          failedRequests: state.failed
            .slice(failStart)
            .reduce<Record<string, number>>((out, key) => {
              out[key] = (out[key] ?? 0) + 1;
              return out;
            }, {}),
          renderedTextSha256: createHash('sha256')
            .update(snapshot.renderedText)
            .digest('hex'),
        },
      };
    } catch (error) {
      if (!/Execution context was destroyed|navigating/i.test(String(error)))
        throw error;
      await deadline.sleep(50);
    }
  }
  throw new ScrapeFailure(
    'NAVIGATION_UNSTABLE',
    'Document changed repeatedly while capturing content',
  );
};
