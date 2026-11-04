import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'proxy-chain';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { scrapePage } from '../helpers/scrape-page';
import { Deadline } from '../helpers/scrape-control';
import { ssrfPrepareRequest } from '../helpers/ssrf';
import { webkitFilterPort } from '../helpers/webkit';

test(
  'a homepage reload interrupting the original-product return stays a closed identity failure',
  { skip: process.env.TEST_WEBKIT !== 'true', timeout: 30000 },
  async (t) => {
    const filterPort = webkitFilterPort(process.env.BROWSER_FILTER_PORT);
    const filter = new Server({
      port: filterPort,
      host: '127.0.0.1',
      prepareRequestFunction: ssrfPrepareRequest({
        allowLocal: false,
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    });
    await filter.listen();
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    const target = 'https://www.amazon.com/Test/dp/B000000042';
    const form =
      '<h4>Click the button below to continue shopping</h4><form method="get" action="/errors_page/validateCaptcha"><input type="hidden" name="amzn" value="opaque"><input type="hidden" name="amzn-r" value="opaque"><input type="hidden" name="field-keywords" value="server"><button type="submit">Continue shopping</button></form>';
    try {
      browser = await launchBrowser(
        browserConfiguration({
          ...process.env,
          BROWSER_ENGINE: 'webkit',
          BROWSER_HEADLESS: 'false',
          BROWSER_CHANNEL: '',
        }),
        { ssrfProxyPort: filterPort },
      );
      for (const mode of ['interrupted', 'ready'])
        await t.test(mode, async () => {
          const context = await browser!.newContext({
            proxy: { server: 'http://127.0.0.1:' + filterPort },
            serviceWorkers: 'block',
          });
          const page = await context.newPage();
          await context.setOffline(true);
          let submissions = 0;
          let productRequests = 0;
          let homeRequests = 0;
          let release!: () => void;
          const homepageReload = new Promise<void>((resolve) => {
            release = resolve;
          });
          await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/errors_page/validateCaptcha') {
              submissions++;
              assert.equal(route.request().method(), 'GET');
              assert.equal(url.searchParams.get('field-keywords'), 'server');
              return route.fulfill({
                contentType: 'text/html',
                body: '<script>location.replace("https://www.amazon.com/")</script>',
              });
            }
            if (url.pathname === '/') {
              homeRequests++;
              if (homeRequests === 2) release();
              return route.fulfill({
                contentType: 'text/html',
                body:
                  '<main>Storefront</main>' +
                  (mode === 'interrupted' && homeRequests === 1
                    ? '<script>setTimeout(()=>location.reload(),150)</script>'
                    : ''),
              });
            }
            assert.equal(url.href, target);
            productRequests++;
            if (submissions && mode === 'interrupted') {
              await homepageReload;
              // The fixture deliberately cancels this pending response.
              await route
                .fulfill({
                  contentType: 'text/html',
                  body: '<main>Requested product 42</main>',
                })
                .catch(() => {});
              return;
            }
            return route.fulfill({
              contentType: 'text/html',
              body: submissions ? '<main>Requested product 42</main>' : form,
            });
          });
          try {
            const operation = scrapePage(
              page,
              target,
              {
                waitUntil: 'domcontentloaded',
                waitAfterLoad: 0,
                readinessTimeout: 1000,
                workflow: 'auto',
              },
              new Deadline(10000),
            );
            if (mode === 'interrupted') {
              await assert.rejects(
                operation,
                (error: any) => error.code === 'WORKFLOW_NAVIGATION_MISMATCH',
              );
              assert.equal(homeRequests, 2);
            } else {
              const result = await operation;
              assert.equal(result.url, target);
              assert.match(result.renderedText, /Requested product 42/);
            }
            assert.equal(submissions, 1);
            assert.equal(productRequests, 2);
          } finally {
            release();
            await context.close();
            assert.equal(page.isClosed(), true);
          }
        });
    } finally {
      await browser?.close();
      await filter.close(true);
    }
  },
);
