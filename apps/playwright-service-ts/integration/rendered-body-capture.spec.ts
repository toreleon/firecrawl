import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { captureRenderedPage } from '../helpers/page-readiness';

test('automatic capture tolerates a temporarily absent document root', async () => {
  const engine = process.env.TEST_RENDER_ENGINE ?? 'rebrowser';
  const browser = await launchBrowser(
    browserConfiguration({
      BROWSER_ENGINE: engine,
      BROWSER_HEADLESS: 'true',
      ...(engine === 'camoufox' ? {} : { BROWSER_CHANNEL: 'chromium' }),
    }),
  );
  try {
    const page = await browser.newPage();
    await page.setContent('<main>Before navigation</main>');
    await page.evaluate(() => document.documentElement.remove());
    const snapshot = await page.evaluate(captureRenderedPage, {
      automatic: true,
    });
    assert.equal(snapshot.content, '');
    assert.equal(snapshot.renderedText, '');
    assert.equal(snapshot.readinessText, '');
  } finally {
    await browser.close();
  }
});

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
      if (path === '/font-probe-late' || path === '/font-probe-empty')
        return res.end(
          '<span style="position:absolute;left:-9999px;font-size:72px">fontProbe42</span><div id="product"></div>' +
            (path === '/font-probe-late'
              ? '<script>setTimeout(()=>document.querySelector("#product").textContent="Visible product details 42",350)</script>'
              : ''),
        );
      if (path === '/main-late' || path === '/main-empty')
        return res.end(
          '<main></main><footer>All data will be encrypted. Opens in new tab.</footer>' +
            (path === '/main-late'
              ? '<script>setTimeout(()=>document.querySelector("main").textContent="Visible product details 42",350)</script>'
              : ''),
        );
      if (path === '/below-fold')
        return res.end(
          '<div style="height:2000px"></div><p>Visible product details 42</p>',
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
      await t.test(
        'off-document probes cannot make an empty body ready',
        async () => {
          for (const path of ['/font-probe-late', '/font-probe-empty']) {
            const result = await scrape(service.baseUrl, url(path), {
              ...controls,
              readiness_timeout: path.endsWith('empty') ? 250 : 1600,
            });
            if (path.endsWith('empty')) {
              assert.equal(result.body.readiness.satisfied, false);
              assert.equal(result.body.errorCode, 'CONTENT_NOT_READY');
            } else {
              assert.equal(result.body.readiness.satisfied, true);
              assert.match(
                result.body.renderedText,
                /Visible product details 42/,
              );
            }
          }
        },
      );
      await t.test(
        'an empty main landmark does not become ready from footer text',
        async () => {
          const late = await scrape(
            service.baseUrl,
            url('/main-late'),
            controls,
          );
          assert.equal(late.body.readiness.satisfied, true);
          assert.match(late.body.renderedText, /Visible product details 42/);
          const empty = await scrape(service.baseUrl, url('/main-empty'), {
            ...controls,
            readiness_timeout: 250,
          });
          assert.equal(empty.body.readiness.satisfied, false);
          assert.equal(empty.body.errorCode, 'CONTENT_NOT_READY');
        },
      );
      await t.test(
        'ordinary text below the fold still satisfies automatic readiness',
        async () => {
          const result = await scrape(
            service.baseUrl,
            url('/below-fold'),
            controls,
          );
          assert.equal(result.body.readiness.satisfied, true);
          assert.match(result.body.renderedText, /Visible product details 42/);
        },
      );
    } finally {
      await service.stop();
      await closeServer(server);
    }
  },
);
