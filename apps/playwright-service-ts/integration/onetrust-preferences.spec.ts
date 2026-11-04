import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { oneTrustPreferencesFixture } from './fixtures/onetrust-preferences';
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
  'native OneTrust preferences reject only supported optional categories and unblock ordinary interactions',
  { timeout: 120000 },
  async (t) => {
    const addresses = await dns.lookup('owned.canadagoose.com', { all: true });
    assert.ok(
      addresses.length &&
        addresses.every((a) => ['127.0.0.1', '::1'].includes(a.address)),
      'owned.canadagoose.com must resolve only to loopback',
    );
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(oneTrustPreferencesFixture(req.url!.slice(1)));
    });
    const port = await listen(server);
    try {
      for (const engine of engines)
        await t.test(engine, async () => {
          const service = await startService({
            BROWSER_ENGINE: engine,
            BROWSER_CHANNEL: ['webkit', 'camoufox'].includes(engine)
              ? ''
              : 'chromium',
          });
          try {
            for (const mode of [
              'standard',
              'footer',
              'unknown',
              'ambiguous',
              'covered',
              'retoggled',
              'rewrite',
              'unconfirmed',
              'off',
              'accept',
              'foreign',
            ]) {
              const happy = ['standard', 'footer'].includes(mode);
              const result = await scrape(
                service.baseUrl,
                `http://${mode === 'foreign' ? '127.0.0.1' : 'owned.canadagoose.com'}:${port}/${mode}`,
                {
                  consent:
                    mode === 'off'
                      ? 'off'
                      : mode === 'accept'
                        ? 'acceptAll'
                        : 'rejectNonEssential',
                  workflow: happy ? 'auto' : 'none',
                  wait_after_load: 0,
                  ...(happy
                    ? {
                        wait_for_text: 'Expanded public details 42',
                        readiness_timeout: 300,
                      }
                    : {}),
                },
              );
              assert.equal(result.status, 200, mode);
              const consent = result.body.interaction.consent;
              const pref = consent.preferenceCenter;
              const output = (id: string, value: string | number) =>
                assert.match(
                  result.body.content,
                  new RegExp(`<output id="${id}">${value}</output>`),
                  mode,
                );
              const receipt = result.body.diagnostics.attempts[0];
              assert.equal(receipt.pageClosed, true, mode);
              assert.equal(receipt.contextClosed, true, mode);
              if (happy) {
                assert.equal(consent.outcome, 'applied', mode);
                assert.equal(pref.outcome, 'applied', mode);
                assert.equal(pref.categoriesFound, 3, mode);
                assert.equal(pref.categoriesChanged, 2, mode);
                assert.equal(pref.categoryActionsAttempted, 2, mode);
                assert.equal(pref.categoryActionsCompleted, 2, mode);
                output('opens', 1);
                output('toggles', 2);
                output('saves', 1);
                output('saved', '000');
                output('accepts', 0);
                assert.match(
                  result.body.renderedText,
                  /Expanded public details 42/,
                );
                assert.equal(
                  result.body.interaction.workflow.observations.productDetails
                    .outcome,
                  'expanded',
                );
                assert.equal(result.body.readiness.satisfied, true);
              } else if (['off', 'accept'].includes(mode)) {
                assert.equal(pref, undefined, mode);
                output('opens', 0);
                output('toggles', 0);
                output('saves', 0);
                output('accepts', mode === 'accept' ? 1 : 0);
              } else {
                assert.equal(consent.outcome, 'unresolved', mode);
                assert.equal(pref.outcome, 'unresolved', mode);
                output('accepts', 0);
                output('opens', mode === 'foreign' ? 0 : 1);
                output('saves', mode === 'unconfirmed' ? 1 : 0);
                output(
                  'toggles',
                  ['retoggled', 'rewrite'].includes(mode)
                    ? 1
                    : mode === 'unconfirmed'
                      ? 2
                      : 0,
                );
                assert.equal(
                  pref.reason,
                  mode === 'covered' || mode === 'unconfirmed'
                    ? 'operation_timeout'
                    : mode === 'foreign' || mode === 'ambiguous'
                      ? 'ambiguous_control'
                      : mode === 'retoggled'
                        ? 'unconfirmed'
                        : 'unsupported_layout',
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
