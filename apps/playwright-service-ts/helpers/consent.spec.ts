import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConsent, prepareConsent } from './workflows';
import { Deadline } from './scrape-control';

test(
  'expired read-only consent discovery cannot continue into late queries or clicks',
  { timeout: 5000 },
  async () => {
    let clicks = 0,
      attributes = 0;
    const locator: any = {
      filter: () => locator,
      first: () => locator,
      isVisible: async () => {
        await new Promise((r) => setTimeout(r, 1400));
        return true;
      },
      getAttribute: async () => {
        attributes++;
        return 'onetrust-banner-sdk';
      },
      count: async () => 1,
      click: async () => {
        clicks++;
      },
      waitFor: async () => {},
    };
    const frame = {
      locator: () => locator,
      evaluate: async () => {},
      isDetached: () => false,
    };
    const page: any = {
      frames: () => [frame],
      mainFrame: () => ({}),
      exposeBinding: async () => {},
      addInitScript: async () => {},
      once: () => {},
    };
    await prepareConsent(page, 'rejectNonEssential', false);
    const result = await applyConsent(
      page,
      'rejectNonEssential',
      new Deadline(4500),
    );
    assert.equal(result.outcome, 'unresolved');
    assert.equal((result as any).diagnostics.probeTimeouts, 1);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(attributes, 0);
    assert.equal(clicks, 0);
  },
);
