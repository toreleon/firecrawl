import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { listen, scrape, startService } from './support';

test('Firefox resets retain their transport code and only explicit stateless retries repeat the browser attempt', { skip: process.env.TEST_CAMOUFOX !== 'true', timeout: 30000 }, async () => {
  const server = net.createServer(socket => socket.destroy());
  const port = await listen(server);
  const service = await startService({ BROWSER_ENGINE: 'camoufox', BROWSER_CHANNEL: '' });
  try {
    for (const max_attempts of [1, 2]) {
      const result = await scrape(service.baseUrl, `https://127.0.0.1:${port}/`, {
        timeout: 8000, wait_after_load: 0, max_attempts,
        skip_tls_verification: true,
      });
      assert.equal(result.status, 500);
      assert.equal(result.body.errorCode, 'NETWORK_ERROR');
      assert.equal(result.body.networkErrorCode, 'NS_ERROR_NET_RESET');
      assert.equal(result.body.diagnostics.attempts.length, max_attempts);
      assert.ok(result.body.diagnostics.attempts.every((a: any) => a.pageClosed && a.networkErrorCode === 'NS_ERROR_NET_RESET'));
    }
    const health = await (await fetch(service.baseUrl + '/health')).json();
    assert.equal(health.activePages, 0);
    assert.equal(health.browserSessions, 0);
  } finally {
    await service.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
