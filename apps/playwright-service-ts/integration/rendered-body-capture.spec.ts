import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'readiness uses rendered body text and waits for the current document parser',
  { timeout: 25000 },
  async (t) => {
    const requests = new Map<string, number>();
    const server = http.createServer((req, res) => {
      const path = req.url!;
      requests.set(path, (requests.get(path) ?? 0) + 1);
      res.setHeader('content-type', 'text/html');
      if (path === '/stream-entry')
        return res.end(
          '<main>Loading...</main><script>setTimeout(()=>location.href="/stream-product",100)</script>',
        );
      if (path === '/stream-product') {
        res.write(
          '<html><head><title>Streamed product</title></head><body><main><h1>Product heading</h1>',
        );
        const timer = setTimeout(
          () =>
            res.end(
              '<p>Complete streamed product details 42</p></main></body></html>',
            ),
          600,
        );
        res.once('close', () => clearTimeout(timer));
        return;
      }
      if (path === '/hidden-late')
        return res.end(
          '<body style="display:none"><script>var bootstrap="not product content";setTimeout(()=>{document.body.style.display="block";document.body.innerHTML="<main>Visible product details 42</main>"},350)</script></body>',
        );
      if (path === '/hidden-empty')
        return res.end(
          '<title>Metadata only</title><body style="display:none"><script>var bootstrap="not product content";</script></body>',
        );
      if (path === '/contents')
        return res.end(
          '<body style="display:contents">Direct public text <main>Visible product details 42</main><p hidden>Hidden private placeholder</p><script>var bootstrap="not product content";</script></body>',
        );
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);
    const engine = process.env.TEST_RENDER_ENGINE ?? 'rebrowser';
    const service = await startService({
      BROWSER_ENGINE: engine,
      BROWSER_CHANNEL: engine === 'camoufox' ? '' : 'chromium',
    });
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    const controls = {
      wait_after_load: 0,
      wait_until: 'domcontentloaded',
      workflow: 'auto',
      readiness_timeout: 1600,
    };
    try {
      await t.test(
        'a passive navigation cannot finish readiness halfway through a streamed document',
        async () => {
          const result = await scrape(
            service.baseUrl,
            url('/stream-entry'),
            controls,
          );
          assert.equal(result.status, 200);
          assert.equal(result.body.readiness.satisfied, true);
          assert.match(
            result.body.renderedText,
            /Complete streamed product details 42/,
          );
          assert.match(
            result.body.content,
            /Complete streamed product details 42/,
          );
          assert.notEqual(
            result.body.readiness.automatic.documentReadyState,
            'loading',
          );
          assert.equal(requests.get('/stream-entry'), 1);
          assert.equal(requests.get('/stream-product'), 1);
        },
      );
      await t.test(
        'a hidden body does not become ready from its script text',
        async () => {
          const result = await scrape(
            service.baseUrl,
            url('/hidden-late'),
            controls,
          );
          assert.equal(result.body.readiness.satisfied, true);
          assert.match(result.body.renderedText, /Visible product details 42/);
          assert.doesNotMatch(result.body.renderedText, /bootstrap/);
          const explicit = await scrape(service.baseUrl, url('/hidden-late'), {
            ...controls,
            wait_for_text: 'Visible product details 42',
          });
          assert.equal(explicit.body.readiness.satisfied, true);
          assert.match(
            explicit.body.renderedText,
            /Visible product details 42/,
          );
        },
      );
      await t.test(
        'a permanently hidden script-only body remains an explicit bounded failure',
        async () => {
          const result = await scrape(service.baseUrl, url('/hidden-empty'), {
            ...controls,
            readiness_timeout: 250,
          });
          assert.equal(result.body.readiness.satisfied, false);
          assert.equal(result.body.errorCode, 'CONTENT_NOT_READY');
          assert.equal(result.body.renderedText, '');
          assert.equal(result.body.readiness.automatic.outcome, 'empty');
          assert.ok(result.body.readiness.automatic.waitMs < 1500);
          assert.equal(result.body.diagnostics.attempts.length, 1);
          assert.equal(requests.get('/hidden-empty'), 1);
        },
      );
      await t.test(
        'display contents still exposes its rendered children and direct text',
        async () => {
          const result = await scrape(
            service.baseUrl,
            url('/contents'),
            controls,
          );
          assert.equal(result.body.readiness.satisfied, true);
          assert.match(result.body.renderedText, /Direct public text/);
          assert.match(result.body.renderedText, /Visible product details 42/);
          assert.doesNotMatch(
            result.body.renderedText,
            /bootstrap|Hidden private placeholder/,
          );
        },
      );
    } finally {
      await service.stop();
      await closeServer(server);
    }
  },
);
