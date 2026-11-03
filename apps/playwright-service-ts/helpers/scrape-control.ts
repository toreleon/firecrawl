export class ScrapeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Deadline {
  private readonly end: number;
  constructor(timeoutMs: number) {
    this.end = Date.now() + timeoutMs;
  }
  remaining() {
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
          timer = setTimeout(() => {
            expired = true;
            reject(
              new ScrapeFailure('SCRAPE_TIMEOUT', 'Scrape deadline exceeded'),
            );
          }, timeout);
        }),
      ]);
    } catch (error) {
      if (error instanceof ScrapeFailure && error.code === 'SCRAPE_TIMEOUT')
        expired = true;
      throw error;
    } finally {
      clearTimeout(timer);
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
