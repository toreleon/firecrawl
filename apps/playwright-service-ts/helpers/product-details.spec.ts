import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandProductDetails, applyWorkflow } from './workflows';
import { Deadline, ScrapeFailure } from './scrape-control';

const fake = () => {
  let expanded = 'false';
  const calls = { count: 0, visible: 0, attribute: 0, clicks: 0 };
  const control = {
    count: async () => (++calls.count, 1),
    isVisible: async () => (++calls.visible, true),
    getAttribute: async () => (++calls.attribute, expanded),
    click: async (_options: { timeout: number }) => {
      calls.clicks++;
      expanded = 'true';
    },
  };
  const page = {
    url: () => 'https://www.canadagoose.com/owned-product',
    getByRole: () => control,
  } as any;
  return {
    page,
    control,
    calls,
    setExpanded: (value: string) => (expanded = value),
  };
};
const timeout = () =>
  Object.assign(new Error('native action timed out'), { name: 'TimeoutError' });

test('an optional native click timeout is unresolved, with no forced or repeated click', async () => {
  const f = fake();
  f.control.click = async (options) => {
    assert.deepEqual(Object.keys(options), ['timeout']);
    assert.ok(options.timeout > 0 && options.timeout <= 2000);
    f.calls.clicks++;
    throw timeout();
  };
  const result = await applyWorkflow(f.page, 'auto', new Deadline(5000));
  assert.deepEqual(result.steps, [
    { type: 'product-details', outcome: 'unresolved' },
  ]);
  assert.equal(result.observations.productDetails?.reason, 'action_timeout');
  assert.equal(result.observations.productDetails?.clickCompleted, false);
  assert.equal(f.calls.clicks, 1);
});

test('a late read-only probe cannot continue querying or click after its budget ends', async () => {
  const f = fake();
  let resolve!: (value: number) => void;
  f.control.count = () =>
    new Promise<number>((done) => {
      resolve = done;
    });
  const result = await expandProductDetails(f.page, new Deadline(5000));
  assert.equal(result.reason, 'probe_timeout');
  assert.equal(result.candidateCount, undefined);
  resolve(1);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(f.calls.visible, 0);
  assert.equal(f.calls.attribute, 0);
  assert.equal(f.calls.clicks, 0);
});

test('expansion requires an observed state change after one completed native click', async () => {
  const f = fake();
  f.control.click = async () => {
    f.calls.clicks++;
    setTimeout(() => f.setExpanded('true'), 80);
  };
  const result = await expandProductDetails(f.page, new Deadline(5000));
  assert.equal(result.outcome, 'expanded');
  assert.equal(result.phase, 'confirm');
  assert.equal(result.clickCompleted, true);
  assert.equal(f.calls.clicks, 1);
});

test('a completed click without expansion stays unresolved and is never repeated', async () => {
  const f = fake();
  f.control.click = async () => {
    f.calls.clicks++;
  };
  const result = await expandProductDetails(f.page, new Deadline(5000));
  assert.equal(result.reason, 'expansion_unconfirmed');
  assert.equal(result.clickCompleted, true);
  assert.equal(f.calls.clicks, 1);
});

test('caller cancellation and browser failures remain terminal', async () => {
  const f = fake();
  const controller = new AbortController();
  f.control.isVisible = async () => {
    controller.abort();
    return true;
  };
  await assert.rejects(
    expandProductDetails(f.page, new Deadline(5000, controller.signal)),
    (error: any) => error.code === 'SCRAPE_CANCELLED',
  );
  assert.equal(f.calls.clicks, 0);
  const closed = new Error('Target page, context or browser has been closed');
  f.control.count = async () => {
    throw closed;
  };
  await assert.rejects(
    expandProductDetails(f.page, new Deadline(5000)),
    (error) => error === closed,
  );
});

test('caller expiry during a native action is not converted into optional success', async () => {
  const f = fake();
  f.control.click = async () => {
    await new Promise((done) => setTimeout(done, 500));
    throw timeout();
  };
  await assert.rejects(
    expandProductDetails(f.page, new Deadline(400)),
    (error: any) =>
      error instanceof ScrapeFailure && error.code === 'SCRAPE_TIMEOUT',
  );
});

test('ambiguous, absent, already-expanded and foreign-host controls are not clicked', async () => {
  for (const count of [0, 2]) {
    const f = fake();
    f.control.count = async () => count;
    const result = await expandProductDetails(f.page, new Deadline(5000));
    assert.equal(result.outcome, count ? 'ambiguous' : 'not_found');
    assert.equal(f.calls.clicks, 0);
  }
  const f = fake();
  f.setExpanded('true');
  assert.equal(
    (await expandProductDetails(f.page, new Deadline(5000))).outcome,
    'already_expanded',
  );
  f.page.url = () => 'https://www.canadagoose.com.attacker.test/product';
  assert.equal(
    (await applyWorkflow(f.page, 'auto', new Deadline(5000))).steps.length,
    0,
  );
  assert.equal(f.calls.clicks, 0);
});
