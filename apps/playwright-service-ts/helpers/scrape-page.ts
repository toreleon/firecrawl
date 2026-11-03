import { Page, Response } from 'playwright';
import { createHash } from 'node:crypto';
import { Deadline, ScrapeFailure } from './scrape-control';
import {
  applyConsent,
  applyWorkflow,
  prepareConsent,
  runActions,
  ConsentPolicy,
  Workflow,
  BrowserAction,
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
};
const documents = new WeakMap<Page, DocumentState>();
const trackDocument = (page: Page) => {
  let state = documents.get(page);
  if (state) return state;
  state = { response: null, revision: 0, navigations: [], failed: [] };
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

export const scrapePage = async (
  page: Page,
  url: string,
  options: ReadinessOptions,
  deadline: Deadline,
) => {
  const state = trackDocument(page);
  const navStart = state.navigations.length;
  const failStart = state.failed.length;
  // Retained tabs use discovery-only injection; awaited explicit CMP controls
  // cannot leave a background consent click racing a later human handoff.
  await prepareConsent(page, options.consent ?? 'off', !options.retained);
  if (!options.continueSession)
    await page.goto(url, {
      waitUntil: options.waitUntil,
      timeout: deadline.remaining(),
    });
  const consent = await deadline.run(
    applyConsent(page, options.consent ?? 'off', deadline),
  );
  const workflow = await deadline.run(
    applyWorkflow(page, options.workflow ?? 'none', deadline),
  );
  const actions = await deadline.run(
    runActions(page, options.actions ?? [], deadline),
  );
  if (options.actions?.length || workflow.steps.length)
    await deadline.run(applyConsent(page, options.consent ?? 'off', deadline));
  if (options.waitAfterLoad > 0) await deadline.sleep(options.waitAfterLoad);
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
  if (options.checkSelector || options.waitForText) {
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
  for (let attempt = 0; attempt < 5; attempt++) {
    deadline.remaining();
    const current = state.response;
    const revision = state.revision;
    const landedUrl = page.url();
    try {
      const snapshot = await deadline.run(
        page.evaluate(
          ({ text, selector, scope }) => {
            let selectorReady = true;
            if (selector) {
              try {
                const element = document.querySelector(selector);
                const style = element && getComputedStyle(element);
                selectorReady =
                  !!element &&
                  style?.display !== 'none' &&
                  style?.visibility !== 'hidden' &&
                  !!element.getClientRects().length;
              } catch {
                selectorReady = true;
              }
            }
            const renderedText = document.body?.innerText ?? '';
            return {
              content: document.documentElement?.outerHTML ?? '',
              renderedText,
              title: document.title,
              url: location.href,
              ready:
                selectorReady &&
                (!text ||
                  (scope === 'title' ? document.title : renderedText)
                    .toLowerCase()
                    .replace(/\s+/g, ' ')
                    .trim()
                    .includes(text.toLowerCase().replace(/\s+/g, ' ').trim())),
            };
          },
          {
            text: options.waitForText,
            selector: options.checkSelector,
            scope: options.readinessScope,
          },
        ),
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
      const contentType = headers['content-type'];
      const rawBody =
        contentType && /application\/json|text\/plain/i.test(contentType);
      const content =
        rawBody && current
          ? (await deadline.run(current.body())).toString('utf8')
          : snapshot.content;
      const readinessSatisfied =
        rawBody && options.waitForText
          ? !options.checkSelector &&
            content
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .includes(
                options.waitForText.toLowerCase().replace(/\s+/g, ' ').trim(),
              )
          : snapshot.ready && selectorReady;
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
        },
        interaction: { consent: { ...consent }, workflow },
        diagnostics: {
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
