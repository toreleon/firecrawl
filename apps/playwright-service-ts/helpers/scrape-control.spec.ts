import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Deadline,
  retryAfterMs,
  boundedClose,
  networkErrorCode,
  isRetryableScrapeError,
  attemptBudgetMs,
  ScrapeFailure,
} from './scrape-control';

test('a timed-out allocation disposes its late result rather than leaking it', async () => {
  let disposed = false;
  await assert.rejects(
    new Deadline(10).run(
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('context'), 30),
      ),
      async () => {
        disposed = true;
      },
    ),
    /deadline/,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(disposed, true);
});

test('typed phase deadlines can recover while cancellation, session loss and hard status failures cannot', async () => {
  const expired = await new Deadline(10)
    .run(new Promise(() => {}))
    .catch((e) => e);
  assert.equal(expired.code, 'SCRAPE_TIMEOUT');
  assert.equal(isRetryableScrapeError(expired), true);
  assert.equal(
    isRetryableScrapeError(
      new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR'),
    ),
    true,
  );
  assert.equal(
    isRetryableScrapeError(new Error('page.goto: net::ERR_CONNECTION_RESET')),
    true,
  );
  assert.equal(
    isRetryableScrapeError(
      new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE'),
    ),
    false,
  );
  assert.equal(
    isRetryableScrapeError(
      new ScrapeFailure('SCRAPE_CANCELLED', 'Timeout while cancelling'),
    ),
    false,
  );
  assert.equal(
    isRetryableScrapeError(
      new ScrapeFailure('SESSION_LOST', 'Timeout waiting for owner'),
    ),
    false,
  );
  assert.equal(
    isRetryableScrapeError(
      new ScrapeFailure('WORKFLOW_NAVIGATION_MISMATCH', 'Wrong product'),
    ),
    false,
  );
});

test('retry planning preserves fixed/readiness waits when a short deadline cannot fit all attempts', () => {
  assert.equal(attemptBudgetMs(1800, 2, 1000, 0), 1800);
  assert.equal(attemptBudgetMs(4800, 3, 0, 5000), 4800);
  assert.equal(attemptBudgetMs(84000, 3, 0, 5000), 28000);
  assert.equal(attemptBudgetMs(4000, 2, 0, 0), 2000);
});

test('Retry-After supports delta seconds and HTTP dates without inventing a delay for malformed values', () => {
  assert.equal(retryAfterMs('30'), 30000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
  assert.equal(retryAfterMs('invalid'), null);
});

test('a stuck browser close cannot indefinitely hold its request permit', async () => {
  assert.equal(await boundedClose(new Promise(() => {}), 20), false);
  assert.equal(await boundedClose(Promise.resolve(), 20), true);
});

test('network diagnostics preserve numeric Chromium protocol names', () => {
  assert.equal(
    networkErrorCode(
      new Error(
        'page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com',
      ),
    ),
    'ERR_HTTP2_PROTOCOL_ERROR',
  );
  assert.equal(
    networkErrorCode('net::ERR_CONNECTION_RESET'),
    'ERR_CONNECTION_RESET',
  );
  assert.equal(networkErrorCode(new Error('unexpected page error')), undefined);
});
