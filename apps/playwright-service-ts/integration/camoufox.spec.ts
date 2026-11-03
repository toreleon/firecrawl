import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'proxy-chain';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { ssrfPrepareRequest } from '../helpers/ssrf';
import {
  closeServer,
  listen,
  readProbe,
  scrape,
  startFixtures,
  startService,
} from './support';

const enabled = process.env.TEST_CAMOUFOX === 'true';

test(
  'Camoufox preserves the browser HTTP contract and isolated request state',
  { skip: !enabled, timeout: 60000 },
  async (t) => {
    const fixtures = await startFixtures();
    const service = await startService({
      BROWSER_ENGINE: 'camoufox',
      BROWSER_CHANNEL: '',
    });
    try {
      await t.test(
        'health and page/worker identity describe Firefox',
        async () => {
          const health = await (
            await fetch(service.baseUrl + '/health')
          ).json();
          assert.equal(health.browserEngine, 'camoufox');
          const result = await scrape(service.baseUrl, fixtures.url + '/gate', {
            check_selector: '#protected-content',
          });
          assert.equal(result.status, 200);
          const probe = readProbe(result.body.content);
          assert.equal(probe.webdriver, false);
          assert.match(probe.userAgent, /Firefox\//);
          assert.equal(probe.userAgent, probe.workerUserAgent);
          assert.equal(probe.platform, probe.workerPlatform);
        },
      );
      await t.test(
        'caller headers, UA and cookies survive a redirect',
        async () => {
          const result = await scrape(
            service.baseUrl,
            fixtures.url + '/redirect',
            {
              headers: {
                'X-Fixture': 'preserved',
                'User-Agent': 'Explicit-Client/1.0',
                Cookie: 'session=caller',
              },
            },
          );
          assert.equal(result.body.pageStatusCode, 200);
          const body = JSON.parse(result.body.content);
          assert.equal(body.header, 'preserved');
          assert.equal(body.userAgent, 'Explicit-Client/1.0');
          assert.match(body.cookie, /session=caller/);
          const next = await scrape(service.baseUrl, fixtures.url + '/json');
          assert.equal(JSON.parse(next.body.content).cookie, null);
        },
      );
      await t.test(
        'unresolved verification and target statuses remain failures',
        async () => {
          const challenge = await scrape(
            service.baseUrl,
            fixtures.url + '/challenge',
          );
          assert.equal(challenge.body.botDetection.provider, 'cloudflare');
          assert.match(
            challenge.body.pageError,
            /Bot protection challenge remains/,
          );
          for (const status of [403, 429]) {
            const result = await scrape(
              service.baseUrl,
              fixtures.url + '/status?code=' + status,
            );
            assert.equal(result.body.pageStatusCode, status);
            assert.ok(result.body.pageError);
          }
        },
      );
      await t.test(
        'a failed selector closes the page and releases capacity',
        async () => {
          const result = await scrape(
            service.baseUrl,
            fixtures.url + '/ordinary',
            { check_selector: '#missing', timeout: 250, wait_after_load: 0 },
          );
          assert.equal(result.status, 500);
          const health = await (
            await fetch(service.baseUrl + '/health')
          ).json();
          assert.equal(health.activePages, 0);
          assert.equal(health.browserSessions, 0);
        },
      );
    } finally {
      await service.stop();
      await fixtures.close();
    }
  },
);

test(
  'Camoufox cannot bypass pinned DNS filtering for private addresses or localhost',
  { skip: !enabled, timeout: 20000 },
  async () => {
    let hits = 0,
      checks = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.end('Private fixture');
    });
    const port = await listen(server);
    const prepare = ssrfPrepareRequest({
      allowLocal: false,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const proxy = new Server({
      port: 0,
      host: '127.0.0.1',
      prepareRequestFunction: async (args) => {
        checks++;
        return prepare(args);
      },
    });
    await proxy.listen();
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'camoufox',
        BROWSER_HEADLESS: 'true',
      }),
    );
    try {
      const context = await browser.newContext({
        proxy: { server: 'http://127.0.0.1:' + proxy.port },
        viewport: null,
      });
      const page = await context.newPage();
      for (const target of [
        'http://127.0.0.1:' + port,
        'http://private-fixture.test:' + port,
      ]) {
        await page
          .goto(target, { timeout: 5000, waitUntil: 'domcontentloaded' })
          .catch(() => {});
        assert.equal(hits, 0);
      }
      assert.ok(checks >= 2);
      assert.equal(
        await page.evaluate(() => typeof RTCPeerConnection),
        'undefined',
      );
      await context.close();
    } finally {
      await browser.close();
      await proxy.close(true);
      await closeServer(server);
    }
  },
);
