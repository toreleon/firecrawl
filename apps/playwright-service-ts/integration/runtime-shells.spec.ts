import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'observed verification shells and format-only hydration keep their HTTP contract',
  { timeout: 60000 },
  async (t) => {
    const counts = new Map<string, number>();
    const server = http.createServer((req, res) => {
      const route = req.url!;
      counts.set(route, (counts.get(route) ?? 0) + 1);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // Fixture SDK tags identify observed markup; no vendor request is made.
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'nonce-fixture'",
      );
      if (route === '/passive' || route === '/passive-forever')
        return res.end(
          '<title>Pardon Our Interruption...</title><p>Checking your browser before you access eBay.</p><form id="destForm" method="GET" action="/final"></form><script src="https://ir.ebaystatic.com/rs/c/challenge-fixture.js"></script>' +
            (route === '/passive'
              ? '<script nonce="fixture">setTimeout(()=>location.href="/final",350)</script>'
              : ''),
        );
      if (route === '/aws-passive') {
        res.statusCode = 202;
        res.setHeader('x-amzn-waf-action', 'challenge');
        return res.end(
          '<p>Browser initialization</p><script nonce="fixture">setTimeout(()=>location.href="/final",350)</script>',
        );
      }
      if (route === '/aws-captcha') {
        res.statusCode = 405;
        return res.end(
          '<title>Human Verification</title><script src="https://abc.def.us-east-1.captcha.awswaf.com/a/b/c/captcha.js"></script><div id="captcha-container"><button id="amzn-captcha-verify-button" onclick="fetch(\'/submitted\')">Begin</button></div>',
        );
      }
      if (route === '/sttc/px/captcha-v2/index.html')
        return res.end(
          '<title>Travel</title><div id="app_main"><div id="px-captcha"></div><p>c4edbd88-d790-11f1-acc3-9f65e4b607cd</p></div>',
        );
      if (route === '/format' || route === '/format-forever')
        return res.end(
          '<main>\u200b\u200d\u2060</main>' +
            (route === '/format'
              ? '<script nonce="fixture">setTimeout(()=>document.querySelector("main").textContent="Hydrated public product 42",350)</script>'
              : ''),
        );
      if (route === '/contact')
        return res.end(
          '<title>Contact us</title><main>Contact public company 42</main><div id="captcha-container"></div><script src="https://abc.eu-central-1.captcha-sdk.awswaf.com/abc/jsapi.js"></script>',
        );
      res.end('<main>Final public product 42</main>');
    });
    const port = await listen(server);
    try {
      const engines = [
        'rebrowser',
        ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
      ];
      for (const engine of engines)
        await t.test(engine, async (t) => {
          const service = await startService({
            BROWSER_ENGINE: engine,
            ...(engine === 'camoufox' ? { BROWSER_CHANNEL: '' } : {}),
          });
          const url = (route: string) => `http://127.0.0.1:${port}${route}`;
          const options = {
            wait_after_load: 0,
            wait_until: 'domcontentloaded',
            workflow: 'auto',
            readiness_timeout: 1500,
            max_attempts: 1,
          };
          try {
            await t.test(
              'passive browser checks wait for the actual redirected document without answer hints',
              async () => {
                for (const route of ['/passive', '/aws-passive']) {
                  const result = await scrape(
                    service.baseUrl,
                    url(route),
                    options,
                  );
                  assert.equal(result.body.pageStatusCode, 200);
                  assert.equal(result.body.url, url('/final'));
                  assert.match(
                    result.body.renderedText,
                    /Final public product 42/,
                  );
                  assert.equal(result.body.botDetection, undefined);
                  assert.equal(result.body.readiness.satisfied, true);
                  assert.equal(result.body.diagnostics.attempts.length, 1);
                }
              },
            );
            await t.test(
              'an unresolved passive shell is bounded and never labeled recovered content',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  url('/passive-forever'),
                  { ...options, readiness_timeout: 350 },
                );
                assert.equal(result.body.botDetection.provider, 'ebay');
                assert.equal(result.body.readiness.satisfied, false);
                assert.equal(
                  result.body.interaction.state,
                  'VERIFICATION_REQUIRED',
                );
                assert.ok(result.body.readiness.automatic.waitMs < 2000);
              },
            );
            await t.test(
              'AWS and empty HUMAN shells stay explicit without clicking or replaying',
              async () => {
                for (const [route, provider] of [
                  ['/aws-captcha', 'aws-waf'],
                  ['/sttc/px/captcha-v2/index.html', 'perimeterx'],
                ]) {
                  const before = counts.get(route) ?? 0;
                  const result = await scrape(service.baseUrl, url(route), {
                    ...options,
                    max_attempts: 2,
                  });
                  assert.equal(result.body.botDetection.provider, provider);
                  assert.equal(
                    result.body.interaction.state,
                    'HUMAN_REQUIRED',
                  );
                  assert.equal(result.body.diagnostics.attempts.length, 1);
                  assert.equal(counts.get(route), before + 1);
                }
                assert.equal(counts.get('/submitted'), undefined);
              },
            );
            await t.test(
              'format characters cannot satisfy hydration but ordinary SDK embeds remain usable',
              async () => {
                const ready = await scrape(
                  service.baseUrl,
                  url('/format'),
                  options,
                );
                assert.match(
                  ready.body.renderedText,
                  /Hydrated public product 42/,
                );
                assert.equal(ready.body.readiness.satisfied, true);
                const empty = await scrape(
                  service.baseUrl,
                  url('/format-forever'),
                  { ...options, readiness_timeout: 350 },
                );
                assert.equal(empty.body.readiness.satisfied, false);
                assert.equal(
                  empty.body.interaction.state,
                  'CONTENT_NOT_READY',
                );
                const contact = await scrape(
                  service.baseUrl,
                  url('/contact'),
                  options,
                );
                assert.equal(contact.body.botDetection, undefined);
                assert.equal(contact.body.readiness.satisfied, true);
              },
            );
            const health = await (
              await fetch(service.baseUrl + '/health')
            ).json();
            assert.equal(health.activePages, 0);
            assert.equal(health.browserSessions, 0);
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(server);
    }
  },
);
