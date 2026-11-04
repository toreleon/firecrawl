import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, browserConfiguration } from '../helpers/browser';
import { prepareConsent, applyConsent } from '../helpers/workflows';
import { Deadline } from '../helpers/scrape-control';
import type { Route } from 'playwright';

test(
  'a blocked auxiliary frame cannot consume consent discovery or cause a late consent click',
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
          let blockedRoute!: (route: Route) => void;
          const blocked = new Promise<Route>((resolve) => {
            blockedRoute = resolve;
          });
          await page.route('**/*', (route) => {
            if (new URL(route.request().url()).pathname === '/block') {
              blockedRoute(route);
              return;
            }
            return route.fulfill({
              contentType: 'text/html',
              body:
                new URL(route.request().url()).hostname === 'embedded.test'
                  ? '<script>const r=new XMLHttpRequest();r.open("GET","/block",false);r.send()</script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="parent.postMessage(\'late-choice\',\'*\')">Reject All</button></div>'
                  : '<body data-choices="0" data-late-choices="0"><main id="content" hidden>Ready public content 42</main><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.body.dataset.choices=String(Number(document.body.dataset.choices)+1);document.querySelector(\'#content\').hidden=false;document.querySelector(\'#onetrust-banner-sdk\').remove()">Reject All</button></div><script>addEventListener(\'message\',e=>{if(e.data===\'late-choice\')document.body.dataset.lateChoices=String(Number(document.body.dataset.lateChoices)+1)})</script><iframe src="https://embedded.test/"></iframe>',
            });
          });
          await prepareConsent(page, 'rejectNonEssential', false);
          const childNavigation = page.waitForEvent(
            'framenavigated',
            (frame) => frame.url() === 'https://embedded.test/',
          );
          await page.goto('https://page.test/', {
            waitUntil: 'domcontentloaded',
          });
          const child = await childNavigation;
          const held = await new Deadline(5000).run(blocked);
          const consent = await new Deadline(6000).run(
            applyConsent(page, 'rejectNonEssential', new Deadline(12000)),
          );
          assert.equal(consent.outcome, 'applied', JSON.stringify(consent));
          assert.equal(consent.diagnostics?.probeTimeouts, 1);
          assert.equal(consent.diagnostics?.mainFrameProbeTimeouts, 0);
          assert.equal(
            await page.locator('#content').innerText(),
            'Ready public content 42',
          );
          assert.equal(
            await page.locator('body').getAttribute('data-choices'),
            '1',
          );
          await held.fulfill({ contentType: 'text/plain', body: 'released' });
          await child.waitForLoadState('domcontentloaded', { timeout: 3000 });
          {
            await new Promise((r) => setTimeout(r, 350));
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
