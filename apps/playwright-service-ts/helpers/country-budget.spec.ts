import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkflow } from './workflows';
import { Deadline } from './scrape-control';

const url = 'https://www.bestbuy.com/site/owned/42.p?skuId=42';
test('a completed country poll at the discovery boundary stays unresolved without a late navigation', async (t) => {
  for (const stage of ['text', 'links']) {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const calls = { text: 0, links: 0, navigation: 0 };
    const page = {
      url: () => url,
      evaluate: async () => {
        calls.text++;
        if (stage === 'text' && calls.text === 2) {
          await Promise.resolve();
          now = 5000;
        }
        return 'Choose a country';
      },
      locator: () => ({
        evaluateAll: async () => {
          calls.links++;
          if (stage === 'links' && calls.links === 2) {
            await Promise.resolve();
            now = 5000;
            return [url + '&intl=nosplash'];
          }
          return ['https://other.test/wrong?intl=nosplash'];
        },
      }),
      goto: async () => {
        calls.navigation++;
      },
    } as any;
    const deadline = new Deadline(12000);
    t.mock.method(deadline, 'sleep', async () => {
      now = 4999;
    });
    const result = await applyWorkflow(page, 'auto', deadline);
    assert.equal(result.steps[0]?.outcome, 'destination_not_ready', stage);
    assert.equal(result.observations.countrySelection?.observed, true, stage);
    assert.equal(
      result.observations.countrySelection?.candidateCount,
      1,
      stage,
    );
    assert.equal(deadline.remaining(), 7000, stage);
    assert.deepEqual(calls, {
      text: 2,
      links: stage === 'text' ? 1 : 2,
      navigation: 0,
    });
    t.mock.restoreAll();
  }
});

test('the country discovery window bounds both RPCs and cannot navigate from a late result', async () => {
  await Promise.all(
    ['text', 'links'].map(async (stage) => {
      let resolve!: (value: any) => void;
      const pending = new Promise<any>((done) => {
        resolve = done;
      });
      const calls = { text: 0, links: 0, navigation: 0 };
      const phases: string[] = [];
      const page = {
        url: () => url,
        evaluate: async () => {
          calls.text++;
          return stage === 'text' ? pending : 'Choose a country';
        },
        locator: () => ({
          evaluateAll: async () => {
            calls.links++;
            return pending;
          },
        }),
        goto: async () => {
          calls.navigation++;
        },
      } as any;
      const deadline = new Deadline(7000);
      await assert.rejects(
        applyWorkflow(page, 'auto', deadline, (phase) => phases.push(phase)),
        (error: any) => error.code === 'SCRAPE_TIMEOUT',
      );
      assert.ok(
        deadline.remaining() > 1000,
        'discovery must leave caller budget for a distinct engine',
      );
      assert.equal(phases.at(-1), `workflow-country-${stage}`);
      resolve(stage === 'text' ? 'Choose a country' : [url + '&intl=nosplash']);
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(calls.navigation, 0);
      assert.equal(calls.links, stage === 'text' ? 0 : 1);
    }),
  );
});

test('a completed country read cannot hide caller expiry at either RPC boundary', async (t) => {
  for (const stage of ['text', 'links']) {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    let navigations = 0;
    const finish = async (value: any) => {
      await Promise.resolve();
      now = 12000;
      return value;
    };
    const page = {
      url: () => url,
      evaluate: () =>
        stage === 'text'
          ? finish('Choose a country')
          : Promise.resolve('Choose a country'),
      locator: () => ({
        evaluateAll: () => finish([url + '&intl=nosplash']),
      }),
      goto: async () => {
        navigations++;
      },
    } as any;
    await assert.rejects(
      applyWorkflow(page, 'auto', new Deadline(12000)),
      (error: any) => error.code === 'SCRAPE_TIMEOUT',
      stage,
    );
    assert.equal(navigations, 0, stage);
    t.mock.restoreAll();
  }
});

test('country navigation uses a native thirty-second cap and preserves the validated destination', async () => {
  let options: any;
  let destination = '';
  const phases: string[] = [];
  const timeout = Object.assign(new Error('navigation timed out'), {
    name: 'TimeoutError',
  });
  const page = {
    url: () => url,
    evaluate: async () => 'Choose a country',
    locator: () => ({
      evaluateAll: async () => [
        'https://evil.test/site/owned/42.p?skuId=42&intl=nosplash',
        url.replace('skuId=42', 'skuId=43') + '&intl=nosplash',
        url + '&intl=nosplash',
      ],
    }),
    goto: async (next: string, value: any) => {
      destination = next;
      options = value;
      throw timeout;
    },
  } as any;
  await assert.rejects(
    applyWorkflow(page, 'auto', new Deadline(60000), (phase) =>
      phases.push(phase),
    ),
    (error) => error === timeout,
  );
  assert.equal(destination, url + '&intl=nosplash');
  assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 30000 });
  assert.equal(phases.at(-1), 'workflow-country-navigation');
});

test('caller cancellation interrupts discovery and leaves no late link query or navigation', async () => {
  const controller = new AbortController();
  let release!: (value: string) => void;
  let queries = 0;
  let navigations = 0;
  const page = {
    url: () => url,
    evaluate: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    locator: () => ({
      evaluateAll: async () => {
        queries++;
        return [url + '&intl=nosplash'];
      },
    }),
    goto: async () => {
      navigations++;
    },
  } as any;
  const operation = applyWorkflow(
    page,
    'auto',
    new Deadline(7000, controller.signal),
  );
  controller.abort();
  await assert.rejects(
    operation,
    (error: any) => error.code === 'SCRAPE_CANCELLED',
  );
  release('Choose a country');
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(queries, 0);
  assert.equal(navigations, 0);
});

test('a late navigation cannot report success after caller expiry', async () => {
  const page = {
    url: () => url,
    evaluate: async () => 'Choose a country',
    locator: () => ({ evaluateAll: async () => [url + '&intl=nosplash'] }),
    goto: async (_url: string, options: { timeout: number }) => {
      assert.ok(options.timeout > 0 && options.timeout <= 100);
      await new Promise((done) => setTimeout(done, 500));
    },
  } as any;
  await assert.rejects(
    applyWorkflow(page, 'auto', new Deadline(400)),
    (error: any) => error.code === 'SCRAPE_TIMEOUT',
  );
});
