import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'automatic readiness waits for visible primary-content busy regions and does not replay a verification page',
  { timeout: 20000 },
  async (t) => {
    const requests = new Map<string, number>();
    const server = http.createServer((req, res) => {
      const name = req.url!;
      requests.set(name, (requests.get(name) ?? 0) + 1);
      res.setHeader('content-type', 'text/html');
      if (name === '/verification') {
        res.statusCode = 429;
        return res.end(
          '<form id="captcha-form" action="index" method="post"><div class="g-recaptcha"></div></form><p>Our systems have detected unusual traffic from your computer network.</p>',
        );
      }
      if (name === '/ignored')
        return res.end(
          '<header aria-busy="true">Background navigation</header><main>Actual content 42<div role="region" aria-label="Leaderboard advertisement" data-ad-status="rendering" aria-busy="true" style="height:40px;width:300px"></div><div aria-busy="true" hidden>Hidden</div><div aria-hidden="true"><div aria-busy="true">Ignored</div></div><div aria-busy="true" style="position:absolute;top:5000px">Below viewport</div></main>',
        );
      if (name === '/supporting-aside' || name === '/supporting-role') {
        const tag =
          name === '/supporting-aside' ? 'aside' : 'div role="complementary"';
        const end = name === '/supporting-aside' ? 'aside' : 'div';
        return res.end(
          `<main><article>Actual content 42</article><${tag}><ul aria-busy="true" style="height:40px;width:300px"><li>Loading supporting widgets</li></ul></${end}></main>`,
        );
      }
      if (name === '/aside-fallback')
        return res.end(
          '<aside><div aria-busy="true" style="height:40px;width:300px">Supporting content loading</div></aside>',
        );
      if (name === '/aside-main')
        return res.end(
          '<aside role="main"><div aria-busy="true" style="height:40px;width:300px">Primary content loading</div></aside>',
        );
      if (name === '/primary-in-aside')
        return res.end(
          '<aside><main><div aria-busy="true" style="height:40px;width:300px">Primary content loading</div></main></aside>',
        );
      if (name === '/wrapper-busy')
        return res.end(
          '<div aria-busy="true"><main>Actual content 42<aside>Supporting content</aside></main></div>',
        );
      if (name === '/main-and-aside-busy')
        return res.end(
          '<main><h1>Search results</h1><div id="results" aria-busy="true" style="height:40px;width:300px"></div><aside><div aria-busy="true" style="height:40px;width:300px">Loading supporting widgets</div></aside></main><script>setTimeout(()=>{document.querySelector("#results").innerHTML="<article>Hydrated public results 42</article>";document.querySelector("#results").setAttribute("aria-busy","false")},350)</script>',
        );
      const bodyScope = name === '/body';
      res.end(
        `<header>Search navigation</header><${bodyScope ? 'div' : 'main'}><h1>Search results</h1><div id="results" aria-busy="true" style="width:300px;height:40px"></div></${bodyScope ? 'div' : 'main'}><footer>Site footer</footer>${name === '/forever' ? '' : '<script>setTimeout(()=>{document.querySelector("#results").innerHTML="<article>Hydrated public results 42</article>";document.querySelector("#results").setAttribute("aria-busy","false")},350)</script>'}`,
      );
    });
    const port = await listen(server);
    const service = await startService({ BROWSER_ENGINE: 'rebrowser' });
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    const controls = {
      wait_after_load: 0,
      wait_until: 'domcontentloaded',
      workflow: 'auto',
      readiness_timeout: 1200,
    };
    try {
      await t.test(
        'a header and footer cannot satisfy a loading primary region',
        async () => {
          for (const path of ['/main', '/body']) {
            const result = await scrape(service.baseUrl, url(path), controls);
            assert.equal(result.status, 200);
            assert.match(
              result.body.renderedText,
              /Hydrated public results 42/,
            );
            assert.equal(result.body.readiness.satisfied, true);
            assert.equal(result.body.readiness.automatic.busyCount, 0);
            assert.ok(result.body.readiness.automatic.maxBusyCount > 0);
            assert.equal(
              result.body.readiness.automatic.busyScope,
              path === '/main' ? 'main' : 'body',
            );
          }
        },
      );
      await t.test(
        'unresolved busy content stays bounded and explicit caller readiness remains authoritative',
        async () => {
          const result = await scrape(service.baseUrl, url('/forever'), {
            ...controls,
            readiness_timeout: 400,
          });
          assert.equal(result.body.readiness.automatic.outcome, 'busy');
          assert.equal(result.body.readiness.satisfied, false);
          assert.equal(result.body.interaction.state, 'CONTENT_NOT_READY');
          assert.ok(result.body.readiness.automatic.waitMs < 1500);
          const explicit = await scrape(service.baseUrl, url('/forever'), {
            ...controls,
            wait_for_text: 'Search results',
          });
          assert.equal(explicit.body.readiness.automatic, undefined);
          assert.equal(explicit.body.readiness.satisfied, true);
        },
      );
      await t.test(
        'hidden, offscreen, advertising and non-primary busy regions do not delay ready main content',
        async () => {
          const result = await scrape(
            service.baseUrl,
            url('/ignored'),
            controls,
          );
          assert.equal(result.body.readiness.satisfied, true);
          assert.equal(result.body.readiness.automatic.busyCount, 0);
          assert.ok(result.body.readiness.automatic.waitMs < 400);
        },
      );
      await t.test(
        'supporting landmarks inside a main do not block ready primary content',
        async () => {
          for (const path of ['/supporting-aside', '/supporting-role']) {
            const result = await scrape(service.baseUrl, url(path), controls);
            assert.equal(result.body.readiness.satisfied, true);
            assert.equal(result.body.readiness.automatic.busyCount, 0);
            assert.equal(
              result.body.readiness.automatic.ignoredComplementaryBusyCount,
              1,
            );
            assert.ok(result.body.readiness.automatic.waitMs < 400);
          }
        },
      );
      await t.test(
        'supporting exclusions preserve primary loading, body fallback, overridden roles and busy ancestors',
        async () => {
          for (const path of [
            '/aside-fallback',
            '/aside-main',
            '/primary-in-aside',
            '/wrapper-busy',
          ]) {
            const result = await scrape(service.baseUrl, url(path), {
              ...controls,
              readiness_timeout: 250,
            });
            assert.equal(result.body.readiness.satisfied, false, path);
            assert.equal(result.body.readiness.automatic.outcome, 'busy', path);
            assert.equal(
              result.body.readiness.automatic.ignoredComplementaryBusyCount,
              0,
              path,
            );
          }
          const hydrated = await scrape(
            service.baseUrl,
            url('/main-and-aside-busy'),
            controls,
          );
          assert.match(
            hydrated.body.renderedText,
            /Hydrated public results 42/,
          );
          assert.equal(hydrated.body.readiness.satisfied, true);
          assert.ok(hydrated.body.readiness.automatic.maxBusyCount > 0);
          assert.equal(
            hydrated.body.readiness.automatic.ignoredComplementaryBusyCount,
            1,
          );
        },
      );
      await t.test(
        'recognized Google unusual-traffic verification is terminal even with two attempts',
        async () => {
          const result = await scrape(service.baseUrl, url('/verification'), {
            ...controls,
            max_attempts: 2,
          });
          assert.equal(result.body.botDetection.provider, 'google');
          assert.equal(result.body.interaction.state, 'VERIFICATION_REQUIRED');
          assert.equal(result.body.diagnostics.attempts.length, 1);
          assert.equal(requests.get('/verification'), 1);
        },
      );
    } finally {
      await service.stop();
      await closeServer(server);
    }
  },
);
