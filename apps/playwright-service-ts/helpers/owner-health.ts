import { performance } from 'node:perf_hooks';

type HealthContext = {
  once(event: 'close', listener: () => void): unknown;
  close(): Promise<unknown>;
};
export type HealthProbeScope = {
  /** Transfer cleanup ownership immediately after context allocation. */
  adopt(context: HealthContext): void;
  /** Check before allocating another resource or reporting probe success. */
  check(): void;
};

const expired = () => new Error('Browser health probe timed out');

/** Share only an in-flight probe, including its confirmed resource disposal. */
export class OwnerHealthProbe<T = void> {
  private pending?: { response: Promise<T> };

  constructor(
    private readonly probe: (scope: HealthProbeScope) => Promise<T>,
    private readonly timeoutMs = 5000,
  ) {}

  check(): Promise<T> {
    if (this.pending) return this.pending.response;
    const until = performance.now() + this.timeoutMs;
    // Start after the shared entry is installed, including for synchronous
    // allocation failures. Caller deadlines never detach resource ownership.
    const operation = Promise.resolve().then(() => this.run(until));
    let timer: NodeJS.Timeout;
    const response = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(expired()), this.timeoutMs);
      operation.then(
        (value) => {
          clearTimeout(timer);
          if (performance.now() >= until) reject(expired());
          else resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    const entry = { response };
    this.pending = entry;
    const drained = () => {
      if (this.pending === entry) this.pending = undefined;
    };
    // A timeout returns unhealthy, but subsequent callers reuse that failure
    // until the outstanding allocation and its context actually finish closing.
    void operation.then(drained, drained);
    return response;
  }

  private async run(until: number): Promise<T> {
    let context: HealthContext | undefined;
    let closed: Promise<void> | undefined;
    const check = () => {
      if (performance.now() >= until) throw expired();
    };
    try {
      check();
      const value = await this.probe({
        check,
        adopt: (allocated) => {
          if (context) throw new Error('Health probe already owns a context');
          context = allocated;
          closed = new Promise<void>((resolve) =>
            allocated.once('close', resolve),
          );
          // A late allocation must be disposed before a new page is requested.
          check();
        },
      });
      if (!context) throw new Error('Health probe did not own a context');
      check();
      return value;
    } finally {
      if (context) {
        const owned = context;
        // The close event is resource proof even if its RPC acknowledgement is
        // lost. A failed/unfinished close without that event keeps the slot.
        void Promise.resolve()
          .then(() => owned.close())
          .catch(() => {});
        await closed;
      }
    }
  }
}
