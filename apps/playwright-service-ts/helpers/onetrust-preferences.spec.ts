import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from 'playwright';
import { Deadline } from './scrape-control';
import { rejectOneTrustPreferences } from './onetrust-preferences';

const blockedDiscovery = () => {
  let release!: (count: number) => void;
  let actions = 0;
  const pending = new Promise<number>((resolve) => {
    release = resolve;
  });
  const locator: any = {
    locator: () => locator,
    count: () => pending,
    click: async () => {
      actions++;
    },
    uncheck: async () => {
      actions++;
    },
  };
  return {
    frame: { locator: () => locator } as unknown as Frame,
    release: () => release(1),
    actions: () => actions,
  };
};
test('an expired preference discovery cannot open settings or apply a late consent choice', async () => {
  const fixture = blockedDiscovery();
  const result = await rejectOneTrustPreferences(
    fixture.frame,
    new Deadline(800),
  );
  assert.equal(result.outcome, 'unresolved');
  assert.equal(result.reason, 'operation_timeout');
  assert.equal(result.settingsOpened, false);
  fixture.release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.actions(), 0);
});
test('caller cancellation propagates and a late read cannot dispatch a consent action', async () => {
  const fixture = blockedDiscovery();
  const controller = new AbortController();
  const pending = rejectOneTrustPreferences(
    fixture.frame,
    new Deadline(3000, controller.signal),
  );
  controller.abort();
  await assert.rejects(
    pending,
    (error) => (error as any).code === 'SCRAPE_CANCELLED',
  );
  fixture.release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.actions(), 0);
});
