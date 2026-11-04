import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { alibabaInterception, ordinaryAlibabaAssets } from './fixtures/alibaba';
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
  'HTTP 200 Alibaba interception stays unresolved without clicking verification, while ordinary products remain ready',
  { timeout: 60000 },
  async (t) => {
    let submissions = 0;
    const fixture = http.createServer((req, res) => {
      if (req.url?.includes('/_____tmd_____/verify/')) submissions++;
      res.setHeader('content-type', 'text/html');
      res.end(
        req.url === '/ordinary'
          ? ordinaryAlibabaAssets()
          : alibabaInterception(),
      );
    });
    const port = await listen(fixture);
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
            const gate = await scrape(service.baseUrl, origin + '/product', {
              workflow: 'auto',
              max_attempts: 1,
              readiness_timeout: 2000,
              wait_after_load: 0,
            });
            assert.equal(gate.status, 200);
            assert.equal(gate.body.pageStatusCode, 200);
            assert.equal(gate.body.botDetection.provider, 'alibaba');
            assert.equal(gate.body.readiness.satisfied, false);
            assert.equal(gate.body.interaction.state, 'HUMAN_REQUIRED');
            assert.equal(gate.body.diagnostics.attempts.length, 1);
            assert.equal(gate.body.diagnostics.attempts[0].pageClosed, true);
            const ordinary = await scrape(
              service.baseUrl,
              origin + '/ordinary',
              { workflow: 'auto', wait_after_load: 0 },
            );
            assert.equal(ordinary.body.botDetection, undefined);
            assert.equal(ordinary.body.readiness.satisfied, true);
            assert.equal(ordinary.body.interaction.state, 'CONTENT_READY');
            assert.match(
              ordinary.body.renderedText,
              /Original public record 42/,
            );
            assert.equal(submissions, 0);
            assert.equal(
              (await (await fetch(service.baseUrl + '/health')).json())
                .activePages,
              0,
            );
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(fixture);
    }
  },
);
