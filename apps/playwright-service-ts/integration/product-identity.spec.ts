import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { scrapePage } from '../helpers/scrape-page';
import { Deadline } from '../helpers/scrape-control';

test(
  'Amazon auto-workflows preserve the original product even without a continuation form',
  { timeout: 30000 },
  async (t) => {
    for (const engine of [
      'rebrowser',
      ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
    ])
      await t.test(engine, async () => {
        const browser = await launchBrowser(
          browserConfiguration({
            BROWSER_ENGINE: engine,
            BROWSER_HEADLESS: 'true',
            ...(engine === 'camoufox'
              ? {}
              : { BROWSER_CHANNEL: 'chromium' }),
          }),
        );
        const target = 'https://www.amazon.com/Product/dp/B000000042';
        try {
          for (const mode of [
            'correct',
            'other-product',
            'storefront',
            'denial',
            'challenge',
          ]) {
            const page = await browser.newPage();
            await page.context().setOffline(true);
            await page.route('**/*', (route) => {
              const current = new URL(route.request().url());
              if (current.href === target && mode !== 'correct')
                return route.fulfill({
                  contentType: 'text/html',
                  body: `<script>location.replace(${JSON.stringify(mode === 'other-product' ? 'https://www.amazon.com/Other/dp/B000000043' : 'https://www.amazon.com/')})</script>`,
                });
              return route.fulfill({
                status: mode === 'denial' ? 403 : 200,
                contentType: 'text/html',
                headers:
                  mode === 'challenge'
                    ? { 'cf-mitigated': 'challenge' }
                    : {},
                body: '<main>Requested product 42</main>',
              });
            });
            const promise = scrapePage(
              page,
              target,
              {
                waitUntil: 'domcontentloaded',
                waitAfterLoad: 150,
                readinessTimeout: 200,
                workflow: 'auto',
              },
              new Deadline(5000),
            );
            if (mode === 'other-product' || mode === 'storefront')
              await assert.rejects(
                promise,
                (e: any) => e.code === 'WORKFLOW_NAVIGATION_MISMATCH',
              );
            else {
              const result = await promise;
              assert.equal(result.status, mode === 'denial' ? 403 : 200);
              if (mode === 'correct') assert.equal(result.url, target);
              if (mode === 'challenge')
                assert.equal(result.readiness.satisfied, false);
            }
            await page.close();
          }
        } finally {
          await browser.close();
        }
      });
  },
);
