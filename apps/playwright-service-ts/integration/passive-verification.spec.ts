import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { scrapePage } from '../helpers/scrape-page';
import { detectPageProtection } from '../helpers/page-readiness';
import { Deadline } from '../helpers/scrape-control';

test(
  'automatic workflows await recognized passive AWS connection pages across HTTP 403',
  { timeout: 30000 },
  async (t) => {
    for (const engine of [
      'rebrowser',
      ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
    ]) {
      await t.test(engine, async () => {
        const browser = await launchBrowser(
          browserConfiguration({
            BROWSER_ENGINE: engine,
            BROWSER_HEADLESS: 'true',
            ...(engine === 'camoufox' ? {} : { BROWSER_CHANNEL: 'chromium' }),
          }),
        );
        try {
          for (const mode of [
            'continue',
            'unresolved',
            'verified-stuck',
            'unknown-stuck',
            'off',
            'denial',
            'captcha',
          ]) {
            const page = await browser.newPage();
            await page.context().setOffline(true);
            const target = 'https://passive-verification.example/public-record';
            await page.route('**/*', (route) => {
              const url = new URL(route.request().url());
              if (url.hostname.endsWith('.awswaf.com'))
                return route.fulfill({
                  contentType: 'application/javascript',
                  body: '/* owned fixture; no vendor challenge code */',
                });
              if (url.pathname === '/interstitial/interstitial.js')
                return route.fulfill({
                  contentType: 'application/javascript',
                  body:
                    mode === 'continue' || mode === 'off'
                      ? 'setTimeout(() => { document.getElementById("status-text").textContent = "Verified! Redirecting..." }, 75); setTimeout(() => location.replace("/public-record?ready=1"), 450)'
                      : mode === 'verified-stuck' || mode === 'unknown-stuck'
                        ? `setTimeout(() => { document.getElementById("status-text").textContent = ${JSON.stringify(mode === 'verified-stuck' ? 'Verified! Redirecting...' : 'Finishing...')} }, 75)`
                        : '',
                });
              if (url.searchParams.has('ready'))
                return route.fulfill({
                  contentType: 'text/html',
                  body: '<title>Public record</title><main>Requested public record is ready</main>',
                });
              return route.fulfill({
                status: mode === 'captcha' ? 405 : 403,
                contentType: 'text/html',
                headers:
                  mode === 'captcha' ? { 'x-amzn-waf-action': 'captcha' } : {},
                body:
                  mode === 'denial' || mode === 'captcha'
                    ? '<title>Access Denied</title><main>The request was denied</main>'
                    : '<title>Verifying Connection</title><script src="https://fixture.edge.sdk.awswaf.com/fixture/challenge.js" defer></script><div id="loading-state"><p id="status-text">Please wait while we verify your browser.</p></div><script src="/interstitial/interstitial.js" defer></script>',
              });
            });
            const start = Date.now();
            const result = await scrapePage(
              page,
              target,
              {
                waitUntil: 'domcontentloaded',
                waitAfterLoad: 0,
                workflow: mode === 'off' ? 'none' : 'auto',
                readinessTimeout: [
                  'unresolved',
                  'verified-stuck',
                  'unknown-stuck',
                ].includes(mode)
                  ? 220
                  : 1800,
              },
              new Deadline(4000),
            );
            if (mode === 'continue') {
              assert.equal(result.status, 200);
              assert.equal(result.readiness.automatic?.outcome, 'ready');
              assert.match(
                result.renderedText,
                /Requested public record is ready/,
              );
              assert.equal(result.readiness.satisfied, true);
              assert.equal(result.diagnostics.navigations.length, 2);
            } else {
              assert.equal(result.status, mode === 'captcha' ? 405 : 403);
              if (
                ['unresolved', 'verified-stuck', 'unknown-stuck'].includes(mode)
              ) {
                assert.equal(
                  result.readiness.automatic?.outcome,
                  'verification',
                );
                assert.equal(result.readiness.satisfied, false);
                if (mode !== 'unknown-stuck')
                  assert.equal(
                    detectPageProtection(
                      result.content,
                      result.headers,
                      result.url,
                    )?.provider,
                    'aws-waf',
                  );
                assert.ok(Date.now() - start >= 180);
              } else {
                assert.equal(result.readiness.automatic, undefined);
                assert.ok(
                  Date.now() - start < 1400,
                  'terminal denials/opt-out must not consume the automatic readiness allowance',
                );
              }
            }
            await page.close();
          }
        } finally {
          await browser.close();
        }
      });
    }
  },
);
