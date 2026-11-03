import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Deadline,
  retryAfterMs,
  boundedClose,
  networkErrorCode,
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
