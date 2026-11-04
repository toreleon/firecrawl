import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { autotraderBlock, ordinaryAutotrader } from './fixtures/autotrader';
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
  'an HTTP 200 Autotrader block is not ready content and support forms remain untouched',
  { timeout: 60000 },
  async (t) => {
    let feedback = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/unexpected-feedback') feedback++;
      res.setHeader('content-type', 'text/html');
      res.end(
        req.url === '/ordinary' ? ordinaryAutotrader() : autotraderBlock(),
      );
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
            const origin = `http://${engine === 'webkit' ? 'webkit-fixture.test' : '127.0.0.1'}:${port}`;
            const gate = await scrape(service.baseUrl, origin + '/vehicle', {
              workflow: 'auto',
              readiness_timeout: 2000,
              wait_after_load: 0,
              max_attempts: 1,
            });
            assert.equal(gate.status, 200);
            assert.equal(gate.body.pageStatusCode, 200);
            assert.match(gate.body.pageError, /^Access blocked/);
            assert.equal(gate.body.botDetection.provider, 'autotrader');
            assert.equal(gate.body.botDetection.denied, true);
            assert.equal(gate.body.readiness.satisfied, false);
            assert.equal(gate.body.readiness.automatic.outcome, 'blocked');
            assert.equal(gate.body.interaction.state, 'ACCESS_DENIED');
            assert.equal(gate.body.diagnostics.attempts.length, 1);
            assert.equal(gate.body.diagnostics.attempts[0].pageClosed, true);
            const ordinary = await scrape(
              service.baseUrl,
              origin + '/ordinary',
              { workflow: 'auto', wait_after_load: 0 },
            );
            assert.equal(ordinary.body.readiness.satisfied, true);
            assert.equal(ordinary.body.interaction.state, 'CONTENT_READY');
            assert.equal(ordinary.body.botDetection, undefined);
            assert.match(
              ordinary.body.renderedText,
              /Original public vehicle 42/,
            );
            assert.equal(feedback, 0);
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(server);
    }
  },
);
