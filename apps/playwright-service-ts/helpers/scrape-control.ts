export class ScrapeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Cleanup must not prevent an error response or hold a concurrency permit. */
export const boundedClose = async (
  operation: Promise<unknown>,
  timeoutMs = 1000,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export class Deadline {
  private readonly end: number;
  constructor(
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.end = Date.now() + timeoutMs;
  }
  remaining() {
    if (this.signal?.aborted)
      throw new ScrapeFailure('SCRAPE_CANCELLED', 'Scrape was cancelled');
    const left = this.end - Date.now();
    if (left <= 0)
      throw new ScrapeFailure('SCRAPE_TIMEOUT', 'Scrape deadline exceeded');
    return left;
  }
  async run<T>(
    operation: Promise<T>,
    onLateResult?: (value: T) => Promise<unknown>,
  ): Promise<T> {
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    operation.then(
      (value) => {
        if (expired && onLateResult) void onLateResult(value).catch(() => {});
      },
      () => {},
    );
    try {
      const timeout = this.remaining();
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          abort = () => {
            expired = true;
            reject(
              new ScrapeFailure('SCRAPE_CANCELLED', 'Scrape was cancelled'),
            );
          };
          this.signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => {
            expired = true;
            reject(
              new ScrapeFailure('SCRAPE_TIMEOUT', 'Scrape deadline exceeded'),
            );
          }, timeout);
        }),
      ]);
    } catch (error) {
      if (
        error instanceof ScrapeFailure &&
        ['SCRAPE_TIMEOUT', 'SCRAPE_CANCELLED'].includes(error.code)
      )
        expired = true;
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) this.signal?.removeEventListener('abort', abort);
    }
  }
  async sleep(ms: number) {
    if (ms >= this.remaining())
      throw new ScrapeFailure(
        'SCRAPE_TIMEOUT',
        'Retry or wait exceeds the scrape deadline',
      );
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class Semaphore {
  private available: number;
  private queue: { resolve: () => void; timer: NodeJS.Timeout }[] = [];
  constructor(permits: number) {
    this.available = permits;
  }
  async acquire(timeoutMs: number) {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const item = {
        resolve,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((queued) => queued !== item);
          reject(
            new ScrapeFailure(
              'SCRAPE_TIMEOUT',
              'Timed out waiting for browser capacity',
            ),
          );
        }, timeoutMs),
      };
      this.queue.push(item);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else this.available++;
  }
  getAvailablePermits() {
    return this.available;
  }
}

export const retryAfterMs = (value: string | undefined, now = Date.now()) => {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
};

export const errorCode = (error: unknown) => {
  if (error instanceof ScrapeFailure) return error.code;
  const message = String(error);
  if (/Timeout|deadline/i.test(message)) return 'SCRAPE_TIMEOUT';
  if (/net::ERR_|ECONN|ENOTFOUND|EAI_AGAIN/.test(message))
    return 'NETWORK_ERROR';
  return 'BROWSER_ERROR';
};

export const networkErrorCode = (error: unknown) =>
  String(error).match(/net::(ERR_[A-Z0-9_]+)/)?.[1];

export const isRetryableScrapeError = (error: unknown) => {
  if (error instanceof ScrapeFailure) return error.code === 'SCRAPE_TIMEOUT';
  const network = networkErrorCode(error);
  if (network)
    return [
      'ERR_CONNECTION_CLOSED',
      'ERR_CONNECTION_RESET',
      'ERR_EMPTY_RESPONSE',
      'ERR_TIMED_OUT',
      'ERR_HTTP2_PROTOCOL_ERROR',
    ].includes(network);
  return errorCode(error) === 'SCRAPE_TIMEOUT';
};

/** maxAttempts is a ceiling; preserve requested waits before splitting the budget. */
export const attemptBudgetMs = (
  remainingMs: number,
  attemptsLeft: number,
  postLoadWaitMs: number,
  readinessMs: number,
) => {
  const minimum = postLoadWaitMs + readinessMs + 300;
  const slots = Math.min(
    attemptsLeft,
    Math.max(1, Math.floor((remainingMs + 250) / (minimum + 250))),
  );
  return Math.max(1, Math.floor(remainingMs / slots));
};
