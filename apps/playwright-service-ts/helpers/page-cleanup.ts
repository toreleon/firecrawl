import type { BrowserContext, Page } from 'playwright';
import { boundedClose } from './scrape-control';

/** Only pass a context that belongs exclusively to a terminal stateless attempt. */
export const closeScrapePage = async (
  page: Pick<Page, 'close' | 'isClosed'>,
  terminalContext?: Pick<BrowserContext, 'close'>,
  timeoutMs = 1000,
) => {
  const started = Date.now();
  let contextClosed = false;
  let finished: boolean;
  if (terminalContext) {
    finished = await boundedClose(
      terminalContext.close().then(() => {
        contextClosed = true;
      }),
      timeoutMs,
    );
    // A failed/stalled context command does not establish page closure.
    if (!page.isClosed())
      finished = (await boundedClose(page.close(), timeoutMs)) && finished;
  } else {
    finished = await boundedClose(page.close(), timeoutMs);
  }
  return {
    pageClosed: page.isClosed(),
    ...(terminalContext && { contextClosed }),
    cleanupFinished: finished,
    cleanupDurationMs: Date.now() - started,
  };
};
