import type { BrowserContext, Page } from 'playwright';
import { boundedClose } from './scrape-control';

type ScrapeContext = Pick<BrowserContext, 'close' | 'once'>;
const disposals = new WeakMap<
  ScrapeContext,
  {
    readonly confirmed: boolean;
    close(): Promise<void>;
  }
>();

/** Observe at allocation, before a context can close or its setup can fail. */
export const contextDisposal = (context: ScrapeContext) => {
  const existing = disposals.get(context);
  if (existing) return existing;
  let confirmed = false;
  let requested = false;
  const closed = new Promise<void>((resolve) =>
    context.once('close', () => {
      confirmed = true;
      resolve();
    }),
  );
  const disposal = {
    get confirmed() {
      return confirmed;
    },
    close() {
      if (!requested && !confirmed) {
        requested = true;
        // A command acknowledgement is not resource proof. Keep ownership
        // through a stalled/rejected command until the actual close event.
        void Promise.resolve()
          .then(() => context.close())
          .catch(() => {});
      }
      return closed;
    },
  };
  disposals.set(context, disposal);
  return disposal;
};

/** Only pass a context that belongs exclusively to a terminal stateless attempt. */
export const closeScrapePage = async (
  page: Pick<Page, 'close' | 'isClosed'>,
  terminalContext?: ScrapeContext,
  timeoutMs = 1000,
) => {
  const started = Date.now();
  let contextClosed = false;
  let finished: boolean;
  if (terminalContext) {
    const disposal = contextDisposal(terminalContext);
    await boundedClose(disposal.close(), timeoutMs);
    // A failed/stalled context command does not establish page closure.
    if (!page.isClosed()) await boundedClose(page.close(), timeoutMs);
    // Disposal can finish while the fallback page command is pending too.
    contextClosed = disposal.confirmed;
    finished = contextClosed;
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
