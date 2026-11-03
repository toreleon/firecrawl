import { Page, Response } from 'playwright';
import { Deadline, ScrapeFailure } from './scrape-control';

export type ReadinessOptions = {
  waitUntil: 'load' | 'domcontentloaded';
  waitAfterLoad: number;
  checkSelector?: string;
  waitForText?: string;
  readinessTimeout: number;
};

// Track document responses, not XHRs/subframes. Snapshot DOM, status and
// headers from the same document after delayed client-side navigations.
export const scrapePage = async (
  page: Page,
  url: string,
  options: ReadinessOptions,
  deadline: Deadline,
) => {
  let documentResponse: Response | null = null;
  const getDocument = (): Response | null => documentResponse;
  const navigations: { url: string; status: number }[] = [];
  const failedRequests: Record<string, number> = {};
  page.on('response', (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigations.push({ url: response.url(), status: response.status() });
      if (response.status() < 300 || response.status() >= 400)
        documentResponse = response;
    }
  });
  page.on('requestfailed', (request) => {
    const code = request.failure()?.errorText ?? 'unknown';
    failedRequests[code] = (failedRequests[code] ?? 0) + 1;
  });
  await page.goto(url, {
    waitUntil: options.waitUntil,
    timeout: deadline.remaining(),
  });
  if (options.waitAfterLoad > 0) await deadline.sleep(options.waitAfterLoad);
  let readinessSatisfied = true;
  if (options.checkSelector || options.waitForText) {
    // Keep a small part of the total budget for capturing failure evidence.
    const readinessEnd =
      Date.now() +
      Math.min(
        options.readinessTimeout,
        Math.max(1, deadline.remaining() - 250),
      );
    try {
      if (options.checkSelector)
        await page
          .locator(options.checkSelector)
          .first()
          .waitFor({
            state: 'visible',
            timeout: Math.max(1, readinessEnd - Date.now()),
          });
      if (options.waitForText) {
        const text = options.waitForText
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        await page.waitForFunction(
          (expected) =>
            (document.body?.innerText ?? '')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .includes(expected),
          text,
          { timeout: Math.max(1, readinessEnd - Date.now()) },
        );
      }
    } catch (error) {
      if (!/Timeout/i.test(String(error))) throw error;
      readinessSatisfied = false;
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    deadline.remaining();
    const current = getDocument();
    const landedUrl = page.url();
    try {
      const content = await deadline.run(page.content());
      const headers = current ? await deadline.run(current.allHeaders()) : {};
      if (current !== getDocument() || landedUrl !== page.url()) {
        await deadline.sleep(50);
        continue;
      }
      const contentType = headers['content-type'];
      const rawBody =
        contentType && /application\/json|text\/plain/i.test(contentType);
      return {
        content:
          rawBody && current
            ? (await deadline.run(current.body())).toString('utf8')
            : content,
        url: rawBody && current ? current.url() : landedUrl,
        status: current?.status() ?? null,
        headers,
        contentType,
        readiness: {
          requested: !!(options.checkSelector || options.waitForText),
          satisfied: readinessSatisfied,
        },
        diagnostics: { navigations, failedRequests },
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
