import type { Page } from 'playwright';
import { Deadline, ScrapeFailure } from './scrape-control';
import { captureRenderedPage, detectPageProtection } from './page-readiness';
import { applyConsent, type ConsentPolicy } from './workflows';

export const lowesProductIdentity = (value: string) => {
  try {
    const url = new URL(value);
    const id = url.pathname.match(/^\/pd\/[^/]+\/(\d{1,20})\/?$/)?.[1];
    if (
      url.protocol !== 'https:' ||
      url.host !== 'www.lowes.com' ||
      url.username ||
      url.password ||
      !id
    )
      return null;
    return { origin: url.origin, id };
  } catch {
    return null;
  }
};

export type LowesSearchObservation = {
  outcome: 'navigated-product' | 'blocked' | 'unresolved';
  phase: 'homepage' | 'search' | 'settle' | 'navigation';
  searchSubmitted: boolean;
  inputCount?: number;
  settleWaitMs?: number;
  reason?: 'unsupported_form' | 'unexpected_document' | 'operation_timeout';
  durationMs: number;
};

/** Use the public storefront's observed identifier-search redirect, without
 * injecting cookies, calling a page SDK or treating search results as a product. */
export const navigateLowesProduct = async (
  page: Page,
  product: NonNullable<ReturnType<typeof lowesProductIdentity>>,
  consent: ConsentPolicy,
  navigationTimeout: number | undefined,
  deadline: Deadline,
  waitUntil: 'load' | 'domcontentloaded',
): Promise<LowesSearchObservation> => {
  const started = Date.now();
  const result: LowesSearchObservation = {
    outcome: 'unresolved',
    phase: 'homepage',
    searchSubmitted: false,
    durationMs: 0,
  };
  const remaining = () => {
    const left = deadline.remaining() - 300;
    if (left < 100)
      throw new ScrapeFailure(
        'SCRAPE_TIMEOUT',
        'Insufficient product-search budget',
      );
    return left;
  };
  const nativeTimeout = (limit = 10000) =>
    Math.min(limit, navigationTimeout ?? 10000, remaining());
  const read = async <T>(operation: Promise<T>) => {
    const value = await deadline.run(operation);
    remaining();
    return value;
  };
  try {
    const response = await page.goto(product.origin + '/', {
      waitUntil: 'domcontentloaded',
      timeout: nativeTimeout(),
    });
    remaining();
    const snapshot = await read(page.evaluate(captureRenderedPage, {}));
    const headers = response ? await read(response.allHeaders()) : {};
    if (
      (response?.status() ?? 0) >= 400 ||
      detectPageProtection(snapshot.content, headers, snapshot.url)
    ) {
      result.outcome = 'blocked';
      return result;
    }
    const home = new URL(snapshot.url);
    if (home.origin !== product.origin || home.pathname !== '/') {
      result.reason = 'unexpected_document';
      return result;
    }
    await applyConsent(page, consent, deadline);
    remaining();
    result.phase = 'search';
    const input = page.locator(
      'form#frmQuickSearch[action="/search"] input#search-query[name="searchTerm"][type="text"]',
    );
    result.inputCount = await read(input.count());
    if (
      result.inputCount !== 1 ||
      !(await read(input.isVisible())) ||
      !(await read(input.isEditable())) ||
      (await read(input.inputValue())) !== ''
    ) {
      result.reason = 'unsupported_form';
      return result;
    }
    const current = new URL(page.url());
    if (current.origin !== product.origin || current.pathname !== '/') {
      result.reason = 'unexpected_document';
      return result;
    }
    await input.click({ timeout: nativeTimeout(2000) });
    remaining();
    await deadline.run(page.keyboard.insertText(product.id));
    remaining();
    result.phase = 'settle';
    // On the observed storefront, immediate submission was denied in both
    // timing pairs; this bounded passive interval reached the original product.
    // It stays inside the caller's deadline and never submits verification.
    await deadline.run(deadline.sleep(5000));
    result.settleWaitMs = 5000;
    remaining();
    const settled = await read(page.evaluate(captureRenderedPage, {}));
    const settledProduct = lowesProductIdentity(settled.url);
    if (
      settledProduct?.origin !== product.origin ||
      settledProduct.id !== product.id
    ) {
      const settledUrl = new URL(settled.url);
      if (settledUrl.origin !== product.origin || settledUrl.pathname !== '/') {
        result.reason = 'unexpected_document';
        return result;
      }
      if (detectPageProtection(settled.content, {}, settled.url)) {
        result.outcome = 'blocked';
        return result;
      }
      // Hydration can replace the input or move focus during the passive wait.
      // Re-resolve the supported field and refuse an altered identifier. Native
      // locator.press focuses that field; a global Enter could hit the body or
      // another control. Navigation retains its separate existing budget.
      result.inputCount = await read(input.count());
      if (
        result.inputCount !== 1 ||
        !(await read(input.isVisible())) ||
        !(await read(input.isEditable())) ||
        (await read(input.inputValue())) !== product.id
      ) {
        result.reason = 'unsupported_form';
        return result;
      }
      await deadline.run(
        input.press('Enter', {
          timeout: nativeTimeout(2000),
          noWaitAfter: true,
        }),
      );
      result.searchSubmitted = true;
      remaining();
    }
    result.phase = 'navigation';
    // The observed native GET /search redirects to /pd/<slug>/<id>. A different
    // product or a results page is never accepted by the caller's capture guard.
    await page.waitForURL(
      (url) => {
        const landed = lowesProductIdentity(url.href);
        return landed?.origin === product.origin && landed.id === product.id;
      },
      {
        waitUntil,
        timeout: nativeTimeout(),
      },
    );
    remaining();
    const landed = lowesProductIdentity(page.url());
    if (landed?.origin === product.origin && landed.id === product.id)
      result.outcome = 'navigated-product';
    else result.reason = 'unexpected_document';
    return result;
  } catch (error) {
    deadline.remaining();
    if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
    result.reason = 'operation_timeout';
    return result;
  } finally {
    result.durationMs = Date.now() - started;
  }
};
