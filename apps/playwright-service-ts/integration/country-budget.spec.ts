import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { countryFixture } from './fixtures/country-budget';
import { closeServer, listen, scrape, startService } from './support';

const engines =
  process.env.TEST_WEBKIT === 'true'
    ? ['webkit']
    : [
        'playwright',
        'patchright',
        'rebrowser',
        ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
      ];
test(
  'bounded country discovery and navigation preserve product identity and closed error receipts',
  { timeout: 120000 },
  async (t) => {
    const addresses = await dns.lookup('www.bestbuy.com', { all: true });
    assert.ok(
      addresses.length &&
        addresses.every(({ address }) =>
          ['127.0.0.1', '::1'].includes(address),
        ),
      'www.bestbuy.com must resolve only to loopback for owned fixtures',
    );
    let wrong = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://owned.test');
      const mode = url.searchParams.get('mode') ?? 'happy';
      if (url.pathname === '/wrong') wrong++;
      if (url.searchParams.has('intl')) {
        if (mode === 'blocked') return;
        res.setHeader('content-type', 'text/html');
        return res.end('<main>Original public product 42</main>');
      }
      const destination = url.pathname + url.search + '&intl=nosplash';
      res.setHeader('content-type', 'text/html');
      res.end(countryFixture(mode, destination));
    });
    const port = await listen(server);
    try {
      for (const engine of engines)
        await t.test(engine, async () => {
          const service = await startService({
            BROWSER_ENGINE: engine,
            BROWSER_CHANNEL:
              engine === 'camoufox' || engine === 'webkit' ? '' : 'chromium',
          });
          try {
            for (const mode of [
              'happy',
              'delayed',
              'rewrite',
              'wrong',
              'blocked',
            ]) {
              const result = await scrape(
                service.baseUrl,
                `http://www.bestbuy.com:${port}/site/owned/42.p?skuId=42&mode=${mode}`,
                {
                  workflow: 'auto',
                  wait_after_load: 0,
                  readiness_timeout: 300,
                  timeout: mode === 'blocked' ? 2500 : 12000,
                },
              );
              const receipt = result.body.diagnostics.attempts[0];
              assert.equal(receipt.pageClosed, true, mode);
              assert.equal(receipt.contextClosed, true, mode);
              if (mode === 'blocked') {
                assert.equal(result.body.errorCode, 'SCRAPE_TIMEOUT');
                assert.equal(
                  receipt.document.phase,
                  'workflow-country-navigation',
                );
              } else {
                assert.equal(
                  result.status,
                  200,
                  JSON.stringify({
                    mode,
                    errorCode: result.body.errorCode,
                    phase: receipt.document?.phase,
                  }),
                );
                const workflow = result.body.interaction.workflow;
                assert.equal(
                  workflow.observations.countrySelection.discoveryTimeoutMs,
                  5000,
                );
                if (mode === 'wrong') {
                  assert.equal(
                    workflow.steps[0]?.outcome,
                    'destination_not_ready',
                  );
                  assert.equal(
                    new URL(result.body.url).searchParams.get('intl'),
                    null,
                  );
                } else {
                  assert.equal(
                    workflow.steps[0]?.outcome,
                    'navigated-original-product',
                  );
                  assert.ok(
                    workflow.observations.countrySelection
                      .navigationTimeoutMs <= 30000,
                  );
                  assert.equal(
                    new URL(result.body.url).pathname,
                    '/site/owned/42.p',
                  );
                  assert.equal(
                    new URL(result.body.url).searchParams.get('skuId'),
                    '42',
                  );
                  assert.match(
                    result.body.renderedText,
                    /Original public product 42/,
                  );
                }
              }
            }
            assert.equal(wrong, 0);
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(server);
    }
  },
);
