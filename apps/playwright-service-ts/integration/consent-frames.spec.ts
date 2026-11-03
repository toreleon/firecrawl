import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, browserConfiguration } from '../helpers/browser';
import { prepareConsent, applyConsent } from '../helpers/workflows';
import { Deadline } from '../helpers/scrape-control';

test(
  'a busy auxiliary frame cannot consume consent discovery or cause a late consent click',
  { timeout: 40000 },
  async (t) => {
    for (const engine of ['rebrowser', 'patchright', 'playwright'])
      await t.test(engine, async () => {
        const browser = await launchBrowser(
          browserConfiguration({
            BROWSER_ENGINE: engine,
            BROWSER_CHANNEL: 'chromium',
            BROWSER_HEADLESS: 'true',
          }),
        );
        try {
          const page = await browser.newPage();
          await page.context().setOffline(true);
          await page.route('**/*', (route) =>
            route.fulfill({
              contentType: 'text/html',
              body:
                new URL(route.request().url()).hostname === 'embedded.test'
                  ? '<script>const end=Date.now()+4500;while(Date.now()<end){}</script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="parent.postMessage(\'late-choice\',\'*\')">Reject All</button></div>'
                  : '<body data-choices="0" data-late-choices="0"><main id="content" hidden>Ready public content 42</main><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.body.dataset.choices=String(Number(document.body.dataset.choices)+1);document.querySelector(\'#content\').hidden=false;document.querySelector(\'#onetrust-banner-sdk\').remove()">Reject All</button></div><script>addEventListener(\'message\',e=>{if(e.data===\'late-choice\')document.body.dataset.lateChoices=String(Number(document.body.dataset.lateChoices)+1)})</script><iframe src="https://embedded.test/"></iframe>',
            }),
          );
          await prepareConsent(page, 'rejectNonEssential', false);
          await page.goto('https://page.test/', {
            waitUntil: 'domcontentloaded',
          });
          const started = Date.now();
          const consent = await new Deadline(3000).run(
            applyConsent(page, 'rejectNonEssential', new Deadline(8000)),
          );
          assert.equal(consent.outcome, 'applied');
          assert.equal((consent as any).diagnostics.probeTimeouts, 1);
          assert.equal(
            await page.locator('#content').innerText(),
            'Ready public content 42',
          );
          assert.equal(
            await page.locator('body').getAttribute('data-choices'),
            '1',
          );
          if (engine === 'rebrowser') {
            await new Promise((r) =>
              setTimeout(r, Math.max(1, 5000 - (Date.now() - started))),
            );
            assert.equal(
              await page.locator('body').getAttribute('data-late-choices'),
              '0',
            );
            assert.equal(
              await page.locator('body').getAttribute('data-choices'),
              '1',
            );
          }
        } finally {
          await browser.close();
        }
      });
  },
);
