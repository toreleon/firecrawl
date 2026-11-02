import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtures, startService, scrape, readProbe } from './support';

test(
  'scraping HTTP contract with real browsers',
  { timeout: 120000 },
  async (t) => {
    const fixtures = await startFixtures();
    try {
      for (const engine of ['playwright', 'patchright', 'rebrowser']) {
        await t.test(engine, async (t) => {
          const service = await startService({ BROWSER_ENGINE: engine });
          try {
            await t.test('health identifies the selected engine', async () => {
              const response = await fetch(`${service.baseUrl}/health`);
              assert.equal(response.status, 200);
              assert.equal((await response.json()).browserEngine, engine);
            });
            await t.test(
              'webdriver gate and worker fingerprint consistency',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  `${fixtures.url}/gate`,
                );
                assert.equal(result.status, 200);
                assert.equal(result.body.pageStatusCode, 200);
                const probe = readProbe(result.body.content);
                assert.equal(probe.webdriver, engine === 'playwright');
                assert.equal(
                  result.body.content.includes('id="protected-content"'),
                  engine !== 'playwright',
                );
                assert.equal(probe.userAgent, probe.workerUserAgent);
                assert.equal(probe.platform, probe.workerPlatform);
                assert.match(probe.userAgent, /Chrome\//);
                assert.doesNotMatch(probe.userAgent, /iPhone|Firefox/);
              },
            );
            await t.test(
              'preserves caller headers, UA, cookies and the landed URL across redirects',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  `${fixtures.url}/redirect`,
                  {
                    headers: {
                      'X-Fixture': 'preserved',
                      'User-Agent': 'Explicit-Client/1.0',
                      Cookie: 'session=caller',
                    },
                  },
                );
                assert.equal(result.status, 200);
                assert.equal(result.body.contentType, 'application/json');
                assert.equal(result.body.url, `${fixtures.url}/json`);
                const data = JSON.parse(result.body.content);
                assert.equal(data.header, 'preserved');
                assert.equal(data.userAgent, 'Explicit-Client/1.0');
                assert.match(data.cookie, /session=caller/);
              },
            );
            await t.test('request contexts do not share cookies', async () => {
              await scrape(service.baseUrl, `${fixtures.url}/set-cookie`);
              const next = await scrape(
                service.baseUrl,
                `${fixtures.url}/json`,
              );
              assert.equal(JSON.parse(next.body.content).cookie, null);
            });
            await t.test(
              'reports an unresolved HTTP 200 bot challenge as an error',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  `${fixtures.url}/challenge`,
                );
                assert.equal(result.status, 200);
                assert.equal(result.body.pageStatusCode, 200);
                assert.equal(result.body.botDetection.provider, 'cloudflare');
                assert.match(
                  result.body.pageError,
                  /Bot protection challenge remains/,
                );
              },
            );
            await t.test(
              'does not reject an ordinary contact form with Turnstile',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  `${fixtures.url}/ordinary`,
                );
                assert.equal(result.body.pageError, undefined);
                assert.equal(result.body.botDetection, undefined);
              },
            );
            await t.test('preserves 403 and 429 target failures', async () => {
              for (const code of [403, 429]) {
                const result = await scrape(
                  service.baseUrl,
                  `${fixtures.url}/status?code=${code}`,
                );
                assert.equal(result.body.pageStatusCode, code);
                assert.match(
                  result.body.pageError,
                  code === 403 ? /Forbidden/ : /Too Many Requests/,
                );
              }
            });
            await t.test(
              'validation rejects missing URL and unsupported URL schemes',
              async () => {
                const missing = await fetch(`${service.baseUrl}/scrape`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                });
                assert.equal(missing.status, 400);
                const invalid = await scrape(
                  service.baseUrl,
                  'file:///etc/passwd',
                );
                assert.equal(invalid.body.pageStatusCode, 403);
              },
            );
            await t.test(
              'a failed selector releases the request context and concurrency permit',
              async () => {
                const result = await scrape(
                  service.baseUrl,
                  `${fixtures.url}/ordinary`,
                  {
                    check_selector: '#missing',
                    timeout: 200,
                    wait_after_load: 0,
                  },
                );
                assert.equal(result.status, 500);
                const health = await (
                  await fetch(`${service.baseUrl}/health`)
                ).json();
                assert.equal(health.status, 'healthy');
                assert.equal(health.activePages, 0);
              },
            );
          } finally {
            await service.stop();
          }
        });
      }
      for (const engine of ['patchright', 'rebrowser']) {
        await t.test(
          `${engine} retains the default private-target SSRF guard`,
          async () => {
            const service = await startService({
              BROWSER_ENGINE: engine,
              ALLOW_LOCAL_WEBHOOKS: 'false',
            });
            try {
              const result = await scrape(
                service.baseUrl,
                `${fixtures.url}/gate`,
              );
              assert.equal(result.body.pageStatusCode, 403);
              assert.equal(result.body.content, '');
              assert.match(result.body.pageError, /private\/internal/);
            } finally {
              await service.stop();
            }
          },
        );
      }
    } finally {
      await fixtures.close();
    }
  },
);
