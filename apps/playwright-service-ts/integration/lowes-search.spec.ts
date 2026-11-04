import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'proxy-chain';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { scrapePage } from '../helpers/scrape-page';
import { Deadline } from '../helpers/scrape-control';
import { ssrfPrepareRequest } from '../helpers/ssrf';
import { webkitFilterPort } from '../helpers/webkit';

const engines =
  process.env.OWNED_LOWES_ENGINES?.split(',') ??
  (process.env.TEST_WEBKIT === 'true'
    ? ['webkit']
    : [
        'playwright',
        'patchright',
        'rebrowser',
        ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
      ]);
const cases = process.env.OWNED_LOWES_CASES?.split(',') ?? [
  'happy',
  'wrong-product',
  'missing-search',
  'verification',
  'off',
  'retained',
  'cancelled',
  'load',
  'budget',
];

test(
  'native product search preserves requested identity and explicit workflows',
  { timeout: 180000 },
  async (t) => {
    const filter = new Server({
      port:
        process.env.TEST_WEBKIT === 'true'
          ? webkitFilterPort(process.env.BROWSER_FILTER_PORT)
          : 0,
      host: '127.0.0.1',
      prepareRequestFunction: ssrfPrepareRequest({
        allowLocal: false,
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    });
    await filter.listen();
    try {
      for (const engine of engines)
        await t.test(engine, async (t) => {
          const browser = await launchBrowser(
            browserConfiguration({
              ...process.env,
              BROWSER_ENGINE: engine,
              BROWSER_CHANNEL: '',
              BROWSER_HEADLESS: engine === 'webkit' ? 'false' : 'true',
            }),
            { ssrfProxyPort: filter.port },
          );
          try {
            for (const mode of cases.filter(
              (mode) =>
                engine === 'camoufox' || ['happy', 'cancelled'].includes(mode),
            ))
              await t.test(mode, async () => {
                const context = await browser.newContext({
                  proxy: { server: 'http://127.0.0.1:' + filter.port },
                  serviceWorkers: 'block',
                });
                const page = await context.newPage();
                // The denying proxy and fulfilled routes keep fixture traffic
                // local. Browser offline mode also blocks native form redirects.
                const origin = 'https://www.lowes.com';
                const target = origin + '/pd/Owned-fixture-product/5010000042';
                const calls: string[] = [];
                let searches = 0;
                let assetFinished = false;
                await page.route('**/*', async (route) => {
                  const url = new URL(route.request().url());
                  calls.push(url.pathname);
                  assert.equal(url.origin, origin);
                  if (url.pathname === '/owned-load.svg') {
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    assetFinished = true;
                    return route.fulfill({
                      contentType: 'image/svg+xml',
                      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />',
                    });
                  }
                  if (url.pathname === '/')
                    return route.fulfill({
                      contentType: 'text/html',
                      body:
                        mode === 'verification'
                          ? '<h1>Security Verification</h1><div id="px-captcha">Verify you are human</div>'
                          : mode === 'missing-search'
                            ? '<main>Public storefront without the supported form</main>'
                            : '<main>Public storefront</main><form id="frmQuickSearch" action="/search"><input type="text" id="search-query" name="searchTerm" aria-label="Search Query"><input type="hidden" name="trusted"><button type="submit">Search</button></form><script>document.querySelector("form").addEventListener("submit",e=>document.querySelector("input[name=trusted]").value=String(e.isTrusted))</script>',
                    });
                  if (url.pathname === '/search') {
                    searches++;
                    assert.equal(route.request().method(), 'GET');
                    assert.equal(
                      url.searchParams.get('searchTerm'),
                      '5010000042',
                    );
                    assert.equal(url.searchParams.get('trusted'), 'true');
                    // Playwright routes only the first URL of an HTTP redirect
                    // chain. Keep the rejecting proxy; use a separate owned
                    // client navigation to exercise native form submission.
                    const destination =
                      mode === 'wrong-product'
                        ? origin + '/pd/Other-product/5010000099'
                        : target + '?idExtracted=true';
                    return route.fulfill({
                      contentType: 'text/html',
                      body:
                        '<script>location.replace(' +
                        JSON.stringify(destination) +
                        ')</script>',
                    });
                  }
                  return route.fulfill({
                    status: searches ? 200 : 403,
                    contentType: 'text/html',
                    body: searches
                      ? '<main>' +
                        (mode === 'wrong-product'
                          ? 'Other product 99'
                          : 'Requested fixture product 42') +
                        '</main>' +
                        (mode === 'load' ? '<img src="/owned-load.svg">' : '')
                      : '<main>Access Denied</main>',
                  });
                });
                try {
                  const usesSearch =
                    engine === 'camoufox' &&
                    !['off', 'retained'].includes(mode);
                  const cancellation = new AbortController();
                  if (mode === 'cancelled') cancellation.abort();
                  const operation = scrapePage(
                    page,
                    target,
                    {
                      waitUntil: mode === 'load' ? 'load' : 'domcontentloaded',
                      navigationTimeout: 2000,
                      waitAfterLoad: 0,
                      readinessTimeout: 300,
                      workflow: mode === 'off' ? 'none' : 'auto',
                      retained: mode === 'retained',
                    },
                    new Deadline(
                      mode === 'budget' ? 3500 : 10000,
                      cancellation.signal,
                    ),
                  );
                  if (mode === 'cancelled') {
                    await assert.rejects(
                      operation,
                      (error: any) => error.code === 'SCRAPE_CANCELLED',
                    );
                    assert.deepEqual(calls, []);
                  } else if (usesSearch && mode === 'budget') {
                    await assert.rejects(
                      operation,
                      (error: any) => error.code === 'SCRAPE_TIMEOUT',
                    );
                    assert.equal(searches, 0);
                    assert.deepEqual(calls, ['/']);
                  } else if (
                    usesSearch &&
                    (mode === 'wrong-product' || mode === 'missing-search')
                  ) {
                    await assert.rejects(
                      operation,
                      (error: any) =>
                        error.code === 'WORKFLOW_NAVIGATION_MISMATCH',
                    );
                  } else {
                    const result = await operation;
                    if (usesSearch && (mode === 'happy' || mode === 'load')) {
                      assert.equal(result.status, 200);
                      assert.match(
                        result.renderedText,
                        /Requested fixture product 42/,
                      );
                      assert.equal(
                        new URL(result.url).pathname,
                        new URL(target).pathname,
                      );
                      assert.equal(searches, 1);
                      assert.deepEqual(calls, [
                        '/',
                        '/search',
                        new URL(target).pathname,
                        ...(mode === 'load' ? ['/owned-load.svg'] : []),
                      ]);
                      if (mode === 'load') {
                        assert.equal(assetFinished, true);
                        assert.equal(
                          await page.evaluate(() => document.readyState),
                          'complete',
                        );
                      }
                    } else if (usesSearch && mode === 'verification') {
                      assert.match(
                        result.renderedText,
                        /Security Verification/,
                      );
                      assert.equal(searches, 0);
                      assert.deepEqual(calls, ['/']);
                    } else {
                      assert.equal(result.status, 403);
                      assert.equal(searches, 0);
                      assert.deepEqual(calls, [new URL(target).pathname]);
                    }
                  }
                  if (mode === 'missing-search') assert.equal(searches, 0);
                } finally {
                  await context.close();
                  assert.equal(page.isClosed(), true);
                }
              });
          } finally {
            await browser.close();
          }
        });
    } finally {
      await filter.close(true);
    }
  },
);
