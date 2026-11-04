import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { productDetailsFixture } from './fixtures/product-details';
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
  'optional product details preserve captures, actionability and truthful expansion state',
  { timeout: 90000 },
  async (t) => {
    // Refuse to contact a real site when an owned-fixture alias is missing.
    const addresses = await dns.lookup('owned.canadagoose.com', { all: true });
    assert.ok(
      addresses.length > 0 &&
        addresses.every(({ address }) => address === '127.0.0.1' || address === '::1'),
      'owned.canadagoose.com must resolve only to loopback for this fixture',
    );
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(productDetailsFixture(req.url?.slice(1) ?? 'happy'));
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
              'clipped',
              'covered',
              'unconfirmed',
              'required',
              'off',
              'foreign',
            ]) {
              const host =
                mode === 'foreign' ? '127.0.0.1' : 'owned.canadagoose.com';
              const result = await scrape(
                service.baseUrl,
                `http://${host}:${port}/${mode}`,
                {
                  workflow: mode === 'off' ? 'none' : 'auto',
                  wait_after_load: 0,
                  readiness_timeout: 300,
                  ...(mode === 'required'
                    ? { wait_for_text: 'Expanded public details 42' }
                    : {}),
                },
              );
              assert.equal(result.status, 200, mode);
              const observation =
                result.body.interaction.workflow.observations.productDetails;
              assert.match(
                result.body.renderedText,
                /Original public product 42/,
                mode,
              );
              assert.equal(
                result.body.readiness.satisfied,
                mode !== 'required',
                mode,
              );
              assert.equal(result.body.diagnostics.attempts.length, 1, mode);
              assert.equal(
                result.body.diagnostics.attempts[0].pageClosed,
                true,
                mode,
              );
              assert.equal(
                result.body.diagnostics.attempts[0].contextClosed,
                true,
                mode,
              );
              assert.match(
                result.body.content,
                new RegExp(
                  `<output id="click-count">${mode === 'happy' || mode === 'unconfirmed' ? 1 : 0}</output>`,
                ),
                mode,
              );
              if (mode === 'happy') {
                assert.equal(observation.outcome, 'expanded');
                assert.equal(observation.clickCompleted, true);
                assert.match(
                  result.body.renderedText,
                  /Expanded public details 42/,
                );
              } else if (mode === 'off' || mode === 'foreign') {
                assert.equal(observation, undefined);
                assert.equal(result.body.interaction.workflow.steps.length, 0);
              } else {
                assert.equal(observation.outcome, 'unresolved', mode);
                assert.equal(
                  observation.reason,
                  mode === 'unconfirmed'
                    ? 'expansion_unconfirmed'
                    : 'action_timeout',
                  mode,
                );
                assert.equal(
                  observation.clickCompleted,
                  mode === 'unconfirmed',
                  mode,
                );
                assert.doesNotMatch(
                  result.body.renderedText,
                  /Expanded public details 42/,
                  mode,
                );
                assert.deepEqual(
                  result.body.interaction.workflow.steps,
                  [{ type: 'product-details', outcome: 'unresolved' }],
                  mode,
                );
              }
            }
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(server);
    }
  },
);
