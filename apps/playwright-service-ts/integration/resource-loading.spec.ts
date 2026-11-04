import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'media policy blocks image/video subresources by type while keeping app scripts and requested documents',
  { timeout: 30000 },
  async () => {
    const received = new Map<string, number>();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=',
      'base64',
    );
    const server = http.createServer((req, res) => {
      const name = new URL(req.url!, 'http://fixture.test').pathname;
      received.set(name, (received.get(name) ?? 0) + 1);
      if (name === '/app.jpg') {
        res.setHeader('content-type', 'application/javascript');
        return res.end(
          'document.querySelector("main").textContent="Application content ready"',
        );
      }
      if (name === '/pixels' || name === '/image.png') {
        res.setHeader('content-type', 'image/png');
        return res.end(png);
      }
      if (name === '/clip') {
        res.setHeader('content-type', 'video/mp4');
        return res.end(Buffer.from('fixture'));
      }
      if (name === '/standalone.svg') {
        res.setHeader('content-type', 'image/svg+xml');
        return res.end(
          '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">Requested document</text></svg>',
        );
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<main>Loading</main><img src="/image.png?version=1"><img src="/pixels"><video src="/clip" preload="auto" muted></video><script src="/app.jpg"></script>',
      );
    });
    const port = await listen(server);
    try {
      for (const block of [false, true]) {
        received.clear();
        const service = await startService({
          BROWSER_ENGINE: 'rebrowser',
          BLOCK_MEDIA: String(block),
        });
        try {
          const health = await (
            await fetch(service.baseUrl + '/health')
          ).json();
          assert.equal(health.blockMedia, block);
          const result = await scrape(
            service.baseUrl,
            `http://127.0.0.1:${port}/`,
            { wait_after_load: 300 },
          );
          assert.equal(result.status, 200);
          assert.match(result.body.renderedText, /Application content ready/);
          assert.equal(
            received.get('/app.jpg'),
            1,
            'scripts must not be classified by filename extension',
          );
          if (block) {
            assert.equal(received.get('/pixels'), undefined);
            assert.equal(received.get('/image.png'), undefined);
            assert.equal(received.get('/clip'), undefined);
            assert.ok(result.body.diagnostics.blockedRequests.media >= 2);
          } else {
            assert.equal(received.get('/pixels'), 1);
            assert.equal(received.get('/image.png'), 1);
            assert.equal(result.body.diagnostics.blockedRequests.media, 0);
          }
          const document = await scrape(
            service.baseUrl,
            `http://127.0.0.1:${port}/standalone.svg`,
            { wait_after_load: 0 },
          );
          assert.equal(document.body.pageStatusCode, 200);
          assert.equal(received.get('/standalone.svg'), 1);
        } finally {
          await service.stop();
        }
      }
    } finally {
      await closeServer(server);
    }
  },
);
