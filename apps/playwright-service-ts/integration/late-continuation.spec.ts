import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { scrapePage } from '../helpers/scrape-page';
import { Deadline } from '../helpers/scrape-control';

test(
  'a late answer-free continuation stays bounded and preserves product identity',
  { timeout: 30000 },
  async (t) => {
    const engine = process.env.TEST_RENDER_ENGINE ?? 'rebrowser';
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: engine,
        BROWSER_HEADLESS: 'true',
        ...(engine === 'camoufox' ? {} : { BROWSER_CHANNEL: 'chromium' }),
      }),
    );
    const target = 'https://www.amazon.com/Test/dp/B000000042';
    const form =
      '<h4>Click the button below to continue shopping</h4><form method="get" action="/errors_page/validateCaptcha"><input type="hidden" name="amzn" value="opaque"><input type="hidden" name="amzn-r" value="opaque"><input type="hidden" name="field-keywords" value="server"><button type="submit">Continue shopping</button></form>';
    try {
      for (const mode of [
        'late',
        'puzzle',
        'other-product',
        'unresolved',
        'actions',
        'retained',
        'workflow-off',
        'expired-readiness',
      ])
        await t.test(mode, async () => {
          const page = await browser.newPage();
          await page.context().setOffline(true);
          let submitted = 0;
          const visits: string[] = [];
          await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            visits.push(url.href);
            if (url.pathname === '/errors_page/validateCaptcha') {
              submitted++;
              assert.equal(route.request().method(), 'GET');
              assert.equal(url.searchParams.get('field-keywords'), 'server');
              return route.fulfill({
                contentType: 'text/html',
                body:
                  mode === 'other-product'
                    ? '<script>location.replace("https://www.amazon.com/Other/dp/B000000043")</script>'
                    : mode === 'unresolved'
                      ? form
                      : `<script>location.replace(${JSON.stringify(target)})</script>`,
              });
            }
            return route.fulfill({
              contentType: 'text/html',
              body: submitted
                ? '<main>Requested product 42</main>'
                : `<main>Loading...</main><script>setTimeout(()=>{document.body.innerHTML=${JSON.stringify(mode === 'puzzle' ? form.replace('</form>', '<input id="captchacharacters" type="text"></form>') : form)}},800)</script>`,
            });
          });
          try {
            const operation = scrapePage(
              page,
              target,
              {
                waitUntil: 'domcontentloaded',
                waitAfterLoad: 0,
                readinessTimeout: mode === 'expired-readiness' ? 150 : 2200,
                workflow: mode === 'workflow-off' ? 'none' : 'auto',
                ...(mode === 'actions'
                  ? { actions: [{ type: 'wait' as const, milliseconds: 50 }] }
                  : {}),
                retained: mode === 'retained',
              },
              new Deadline(8000),
            );
            if (mode === 'other-product') {
              await assert.rejects(
                operation,
                (error: any) => error.code === 'WORKFLOW_NAVIGATION_MISMATCH',
              );
              assert.equal(submitted, 1);
            } else {
              const result = await operation;
              if (mode === 'late') {
                assert.equal(result.readiness.satisfied, true);
                assert.equal(result.url, target);
                assert.match(result.renderedText, /Requested product 42/);
                assert.equal(submitted, 1);
                assert.equal(result.interaction.workflow.steps.length, 1);
                assert.equal(
                  result.interaction.workflow.steps[0].type,
                  'amazon-continue@1',
                );
              } else if (mode === 'unresolved') {
                assert.equal(submitted, 1);
                assert.equal(result.readiness.satisfied, false);
                assert.equal(result.interaction.workflow.steps.length, 1);
                assert.equal(
                  result.interaction.workflow.steps[0].outcome,
                  'verification_unresolved',
                );
              } else {
                assert.equal(submitted, 0);
                assert.equal(result.interaction.workflow.steps.length, 0);
                if (mode !== 'workflow-off')
                  assert.equal(result.readiness.satisfied, false);
              }
            }
            assert.ok(visits.length <= 3);
          } finally {
            await page.close();
          }
        });
    } finally {
      await browser.close();
    }
  },
);
