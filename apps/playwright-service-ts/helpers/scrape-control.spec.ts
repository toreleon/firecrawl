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
  errorCode,
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

test('observed Gecko transport errors remain typed and only transient cases permit explicit retries', () => {
  for (const code of [
    'NS_ERROR_NET_RESET',
    'NS_ERROR_NET_INTERRUPT',
    'NS_ERROR_NET_TIMEOUT',
  ]) {
    const error = new Error(`page.goto: ${code} at https://example.com`);
    assert.equal(networkErrorCode(error), code);
    assert.equal(errorCode(error), 'NETWORK_ERROR');
    assert.equal(isRetryableScrapeError(error), true);
  }
  for (const code of ['NS_ERROR_UNKNOWN_HOST', 'NS_ERROR_CONNECTION_REFUSED']) {
    assert.equal(networkErrorCode(code), code);
    assert.equal(errorCode(code), 'NETWORK_ERROR');
    assert.equal(isRetryableScrapeError(code), false);
  }
  for (const code of [
    'NS_BINDING_ABORTED',
    'SEC_ERROR_UNKNOWN_ISSUER',
    'SSL_ERROR_BAD_CERT_DOMAIN',
    'NS_ERROR_DOM_BAD_URI',
    'NS_ERROR_FAILURE',
  ]) {
    assert.equal(isRetryableScrapeError(code), false);
    assert.equal(networkErrorCode(code), undefined);
  }
});

test('WebKit navigation EOF is transient without reclassifying TLS, renderer or evaluation failures', () => {
  const error = new Error(
    'page.goto: Connection terminated unexpectedly\nCall log:\n  - navigating to https://example.test/',
  );
  assert.equal(networkErrorCode(error), 'WEBKIT_CONNECTION_TERMINATED');
  assert.equal(errorCode(error), 'NETWORK_ERROR');
  assert.equal(isRetryableScrapeError(error), true);
  for (const message of [
    'page.goto: Unacceptable TLS certificate',
    'page.evaluate: Connection terminated unexpectedly',
    'page.evaluate: Target crashed',
    'page.goto: Connection terminated unexpectedly while executing arbitrary code',
  ]) {
    assert.equal(networkErrorCode(new Error(message)), undefined);
    assert.equal(errorCode(new Error(message)), 'BROWSER_ERROR');
    assert.equal(isRetryableScrapeError(new Error(message)), false);
  }
});

test('exact WebKit premature TLS handshake termination is transient without ignoring certificate or policy failures', () => {
  const message = 'page.goto: Peer failed to perform TLS handshake: The TLS connection was non-properly terminated.';
  const error = new Error(message + '\nCall log:\n  - navigating to https://example.test/');
  assert.equal(networkErrorCode(error), 'WEBKIT_TLS_HANDSHAKE_TERMINATED');
  assert.equal(errorCode(error), 'NETWORK_ERROR');
  assert.equal(isRetryableScrapeError(error), true);
  for (const unrelated of [
    'page.goto: Unacceptable TLS certificate',
    'page.goto: Peer failed to perform TLS handshake: certificate validation failed.',
    message.replace('page.goto:', 'page.evaluate:'),
    message + ' arbitrary suffix',
    'prefix ' + message,
  ]) {
    assert.equal(networkErrorCode(new Error(unrelated)), undefined);
    assert.equal(errorCode(new Error(unrelated)), 'BROWSER_ERROR');
    assert.equal(isRetryableScrapeError(new Error(unrelated)), false);
  }
});
