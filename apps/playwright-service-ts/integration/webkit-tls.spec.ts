import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { listen, scrape, startService } from './support';

test(
  'owned premature TLS handshake termination is a transport failure without a TLS exception',
  { timeout: 25000, skip: process.env.TEST_WEBKIT !== 'true' },
  async (t) => {
    const sockets = new Set<net.Socket>();
    let hellos = 0;
    const fixture = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', (data) => {
        assert.equal(data[0], 22);
        hellos++;
        socket.end();
      });
    });
    const port = await listen(fixture);
    const service = await startService({
      BROWSER_ENGINE: 'webkit',
      BROWSER_CHANNEL: '',
    });
    try {
      for (const max_attempts of [1, 2]) {
        const result = await scrape(
          service.baseUrl,
          `https://webkit-fixture.test:${port}`,
          {
            timeout: 8000,
            max_attempts,
            wait_after_load: 0,
            skip_tls_verification: false,
          },
        );
        t.diagnostic(
          JSON.stringify({
            result,
            hellos,
            serviceError: service
              .logs()
              .split('\n')
              .filter((line) => line.startsWith('Scrape error:')),
          }),
        );
        assert.ok(hellos >= 1);
        assert.equal(result.status, 500);
        assert.equal(result.body.errorCode, 'NETWORK_ERROR');
        assert.equal(
          result.body.networkErrorCode,
          'WEBKIT_TLS_HANDSHAKE_TERMINATED',
        );
        assert.equal(result.body.diagnostics.attempts.length, max_attempts);
        assert.ok(
          result.body.diagnostics.attempts.every(
            (a: any) =>
              a.pageClosed === true &&
              a.networkErrorCode === 'WEBKIT_TLS_HANDSHAKE_TERMINATED',
          ),
        );
        assert.equal(
          result.body.diagnostics.attempts.at(-1).contextClosed,
          true,
        );
      }
      const health = await (await fetch(service.baseUrl + '/health')).json();
      assert.equal(health.activePages, 0);
      assert.equal(health.browserSessions, 0);
    } finally {
      await service.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  },
);
