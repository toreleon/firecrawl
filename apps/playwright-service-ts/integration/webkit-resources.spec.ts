import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeServer, listen, scrape, startService } from './support';

const enabled = process.env.TEST_WEBKIT === 'true';

test(
  'WebKit blob resources and navigation EOF preserve the HTTP/security contract',
  { skip: !enabled, timeout: 45000 },
  async (t) => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'firecrawl-webkit-resource-fixture-'),
    );
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let dataRequests = 0,
      transportRequests = 0;
    const sockets = new Set<tls.TLSSocket>();
    const originSockets = new Map<number, tls.TLSSocket>();
    const server = http.createServer((req, res) => {
      if (req.url === '/blob-data') {
        dataRequests++;
        return res.end('Owned blob worker content 42');
      }
      const origin = `http://${req.headers.host}`;
      const worker = `fetch(${JSON.stringify(origin + '/blob-data')}).then(r=>r.text()).then(text=>postMessage(text))`;
      res.setHeader('content-type', 'text/html');
      res.end(
        `<main id="record">Loading...</main><script>const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));worker.onmessage=event=>{document.querySelector('#record').textContent=event.data;worker.terminate()};</script>`,
      );
    });
    let secure: http2.Http2SecureServer | undefined;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=webkit-fixture.test',
          '-keyout',
          path.join(dir, 'key.pem'),
          '-out',
          path.join(dir, 'cert.pem'),
        ],
        { stdio: 'ignore' },
      );
      secure = http2.createSecureServer({
        allowHTTP1: true,
        key: readFileSync(path.join(dir, 'key.pem')),
        cert: readFileSync(path.join(dir, 'cert.pem')),
      });
      secure.on('secureConnection', (socket) => {
        sockets.add(socket);
        originSockets.set(socket.remotePort!, socket);
        socket.on('error', () => {});
        socket.once('close', () => {
          sockets.delete(socket);
          originSockets.delete(socket.remotePort!);
        });
      });
      secure.on('tlsClientError', () => {});
      secure.on('sessionError', () => {});
      secure.on('request', (req) => {
        if (req.httpVersionMajor !== 1) return;
        transportRequests++;
        req.socket.end();
      });
      secure.on('stream', (stream) => {
        transportRequests++;
        stream.on('error', () => {});
        const socket = originSockets.get(stream.session!.socket.remotePort!);
        assert.ok(socket);
        // TLS close_notify without a response: a real navigation EOF, not a
        // thrown test string, a reset stream or a bad-certificate simulation.
        socket.end();
      });
      const port = await listen(server),
        securePort = await listen(secure);
      service = await startService({
        BROWSER_ENGINE: 'webkit',
        BROWSER_CHANNEL: '',
        MAX_CONCURRENT_PAGES: '1',
      });
      const base = `http://webkit-fixture.test:${port}`,
        tlsUrl = `https://webkit-fixture.test:${securePort}`;
      const owner = service;
      await t.test(
        'a blob-backed worker can render content and fetch through the existing filter',
        async () => {
          const result = await scrape(owner.baseUrl, base + '/blob-worker', {
            wait_for_text: 'Owned blob worker content 42',
            readiness_timeout: 1500,
            workflow: 'auto',
            wait_after_load: 0,
            timeout: 5000,
          });
          assert.equal(result.status, 200);
          assert.equal(result.body.errorCode, undefined);
          assert.equal(result.body.interaction.state, 'CONTENT_READY');
          assert.match(
            result.body.renderedText,
            /Owned blob worker content 42/,
          );
          assert.equal(dataRequests, 1);
          assert.equal(result.body.diagnostics.blockedRequests.private, 0);
          assert.equal(result.body.diagnostics.attempts[0].pageClosed, true);
        },
      );
      await t.test('a top-level blob target remains forbidden', async () => {
        const result = await scrape(owner.baseUrl, 'blob:' + base + '/owned');
        assert.equal(result.body.pageStatusCode, 403);
        assert.match(result.body.pageError, /unsupported protocol/);
      });
      await t.test(
        'real navigation EOF is a typed network failure with one closed attempt',
        async () => {
          const before = transportRequests;
          const result = await scrape(owner.baseUrl, tlsUrl, {
            skip_tls_verification: true,
            max_attempts: 1,
            timeout: 5000,
            wait_after_load: 0,
          });
          t.diagnostic(
            JSON.stringify({
              event: 'ownedNavigationEof',
              failedRequests:
                result.body.diagnostics?.attempts?.[0]?.document
                  ?.recentFailedRequests,
            }),
          );
          assert.ok(
            transportRequests > before,
            'fixture must receive a request: ' +
              JSON.stringify({
                status: result.status,
                body: result.body,
                log: owner.logs().slice(-3000),
              }),
          );
          assert.equal(result.status, 500);
          assert.equal(result.body.errorCode, 'NETWORK_ERROR');
          assert.equal(
            result.body.networkErrorCode,
            'WEBKIT_CONNECTION_TERMINATED',
          );
          assert.equal(result.body.diagnostics.attempts.length, 1);
          assert.equal(result.body.diagnostics.attempts[0].pageClosed, true);
        },
      );
      await t.test(
        'an untrusted certificate is rejected before HTTP and is not retryable transport EOF',
        async () => {
          const before = transportRequests;
          const result = await scrape(owner.baseUrl, tlsUrl, {
            skip_tls_verification: false,
            max_attempts: 1,
            timeout: 5000,
            wait_after_load: 0,
          });
          assert.equal(result.status, 500);
          assert.equal(result.body.errorCode, 'BROWSER_ERROR');
          assert.equal(result.body.networkErrorCode, undefined);
          assert.equal(transportRequests, before);
          assert.equal(result.body.diagnostics.attempts[0].pageClosed, true);
        },
      );
      const health = await (await fetch(owner.baseUrl + '/health')).json();
      assert.equal(health.activePages, 0);
      assert.equal(health.browserSessions, 0);
    } finally {
      await service?.stop();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      if (secure)
        await new Promise<void>((resolve) => secure!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
