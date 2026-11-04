import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'initial navigation has an optional phase timeout without shortening post-commit readiness',
  { timeout: 60000 },
  async (t) => {
    const requests = new Map<string, number>();
    const fixture = http.createServer((req, res) => {
      const path = req.url!;
      requests.set(path, (requests.get(path) ?? 0) + 1);
      res.setHeader('content-type', 'text/html');
      if (path === '/hydrate')
        return res.end(
          '<main>Loading...</main><script>setTimeout(()=>document.querySelector("main").textContent="Hydrated public record 42",650)</script>',
        );
      const timer = setTimeout(
        () => res.end('<main>Slow public record 42</main>'),
        path === '/slow' ? 2500 : 450,
      );
      res.once('close', () => clearTimeout(timer));
    });
    const port = await listen(fixture);
    try {
      for (const engine of [
        'rebrowser',
        ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
      ])
        await t.test(engine, async (t) => {
          const service = await startService({
            BROWSER_ENGINE: engine,
            ...(engine === 'camoufox' ? { BROWSER_CHANNEL: '' } : {}),
          });
          const url = (path: string) => `http://127.0.0.1:${port}${path}`;
          const options = {
            timeout: 6000,
            wait_after_load: 0,
            wait_until: 'domcontentloaded',
            workflow: 'auto',
            max_attempts: 1,
          };
          try {
            await t.test(
              'a caller cap closes a stalled initial navigation and returns a completed timeout',
              async () => {
                const result = await scrape(service.baseUrl, url('/slow'), {
                  ...options,
                  navigation_timeout: 250,
                });
                assert.equal(result.status, 500);
                assert.equal(result.body.errorCode, 'SCRAPE_TIMEOUT');
                assert.equal(result.body.diagnostics.attempts.length, 1);
                assert.equal(
                  result.body.diagnostics.attempts[0].pageClosed,
                  true,
                );
                assert.ok(
                  result.body.diagnostics.attempts[0].durationMs < 2000,
                );
              },
            );
            await t.test(
              'omission retains the existing navigation budget',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  url('/ordinary'),
                  options,
                );
                assert.equal(result.status, 200);
                assert.match(result.body.renderedText, /Slow public record 42/);
              },
            );
            await t.test(
              'a fast commit can hydrate longer than the navigation cap',
              async () => {
                const result = await scrape(service.baseUrl, url('/hydrate'), {
                  ...options,
                  navigation_timeout: 250,
                  readiness_timeout: 1500,
                });
                assert.equal(result.status, 200);
                assert.equal(result.body.readiness.satisfied, true);
                assert.match(
                  result.body.renderedText,
                  /Hydrated public record 42/,
                );
              },
            );
            await t.test(
              'the overall deadline still bounds a larger navigation cap',
              async () => {
                const result = await scrape(service.baseUrl, url('/slow'), {
                  ...options,
                  timeout: 500,
                  navigation_timeout: 5000,
                });
                assert.equal(result.status, 500);
                assert.equal(result.body.errorCode, 'SCRAPE_TIMEOUT');
                assert.equal(
                  result.body.diagnostics.attempts[0].pageClosed,
                  true,
                );
              },
            );
            await t.test(
              'invalid caps fail before any target request',
              async () => {
                const before = requests.get('/invalid') ?? 0;
                for (const navigation_timeout of [0, 99, 120001, 1.5, '250']) {
                  const result = await scrape(
                    service.baseUrl,
                    url('/invalid'),
                    { ...options, navigation_timeout },
                  );
                  assert.equal(result.status, 400);
                  assert.equal(result.body.errorCode, 'INVALID_OPTIONS');
                }
                assert.equal(requests.get('/invalid') ?? 0, before);
              },
            );
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(fixture);
    }
  },
);
