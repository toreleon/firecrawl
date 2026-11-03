import { randomBytes } from 'node:crypto';
import { ScrapeFailure } from './scrape-control';

// Tokens are capabilities for this internal service. Never log them. Sessions
// are opt-in, origin/profile-bound, exclusive while in use, bounded and expiring.
export class BrowserSessions<T> {
  private entries = new Map<
    string,
    {
      value: T;
      origin: string;
      profile: string;
      expiresAt: number;
      busy: boolean;
      revision: number;
    }
  >();
  constructor(
    private readonly create: (profile: string) => Promise<T>,
    private readonly dispose: (value: T) => Promise<void>,
    private readonly maximum = 8,
    private readonly ttlMs = 300000,
  ) {}

  async acquire(
    origin: string,
    profile: string,
    token?: string,
    revision?: number,
  ) {
    await this.sweep();
    if (token) {
      const entry = this.entries.get(token);
      if (!entry || entry.expiresAt <= Date.now())
        throw new ScrapeFailure(
          'SESSION_EXPIRED',
          'Session is unknown or expired',
        );
      if (entry.origin !== origin || entry.profile !== profile)
        throw new ScrapeFailure(
          'SESSION_MISMATCH',
          'Session origin or browser configuration differs',
        );
      if (entry.busy)
        throw new ScrapeFailure(
          'SESSION_BUSY',
          'Session already has an active request',
        );
      this.fence(entry, revision);
      entry.busy = true;
      return { token, value: entry.value, expiresAt: entry.expiresAt };
    }
    // Reserve capacity before asynchronous browser creation.
    if (this.entries.size + this.creating >= this.maximum)
      throw new ScrapeFailure(
        'SESSION_LIMIT',
        'Browser session capacity reached',
      );
    this.creating++;
    try {
      const value = await this.create(profile);
      const token = randomBytes(32).toString('hex');
      const entry = {
        value,
        origin,
        profile,
        expiresAt: Date.now() + this.ttlMs,
        busy: true,
        revision: revision ?? 0,
      };
      this.entries.set(token, entry);
      return { token, value, expiresAt: entry.expiresAt };
    } finally {
      this.creating--;
    }
  }
  private creating = 0;
  private fence(entry: { revision: number }, revision?: number) {
    if (
      entry.revision > 0 &&
      (revision === undefined || revision <= entry.revision)
    )
      throw new ScrapeFailure('SESSION_STALE', 'Session command is stale');
    if (revision !== undefined) entry.revision = revision;
  }
  async use<R>(
    token: string,
    run: (value: T) => Promise<R>,
    revision?: number,
  ) {
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= Date.now())
      throw new ScrapeFailure(
        'SESSION_EXPIRED',
        'Session is unknown or expired',
      );
    if (entry.busy)
      throw new ScrapeFailure(
        'SESSION_BUSY',
        'Session already has an active request',
      );
    this.fence(entry, revision);
    entry.busy = true;
    try {
      return await run(entry.value);
    } catch (error) {
      await this.release(token, true);
      throw error;
    } finally {
      await this.release(token);
    }
  }
  async release(token: string, discard = false) {
    const entry = this.entries.get(token);
    if (!entry) return;
    entry.busy = false;
    if (discard || entry.expiresAt <= Date.now()) {
      this.entries.delete(token);
      await this.dispose(entry.value);
    }
  }
  async remove(token: string) {
    const entry = this.entries.get(token);
    if (!entry) return false;
    if (entry.busy)
      throw new ScrapeFailure(
        'SESSION_BUSY',
        'Session already has an active request',
      );
    this.entries.delete(token);
    await this.dispose(entry.value);
    return true;
  }
  async sweep() {
    for (const [token, entry] of this.entries)
      if (!entry.busy && entry.expiresAt <= Date.now())
        await this.remove(token);
  }
  async close() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => this.dispose(entry.value)));
  }
  get size() {
    return this.entries.size;
  }
}
