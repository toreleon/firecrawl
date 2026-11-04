import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listen, closeServer } from './support';

test(
  'benchmark CLI records every attempt, classifies false successes, and retains failure evidence',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'firecrawl-waf-runner-'),
    );
    const root = path.resolve(__dirname, '..');
    let requests = 0;
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health')
        return res.end(
          JSON.stringify({ status: 'healthy', browserEngine: 'test-fixture' }),
        );
      requests++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const page = new URL(body.url).pathname;
      if (page === '/error') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: 'Failed fixture' }));
      }
      if (page === '/invalid') return res.end('null');
      const content =
        page === '/success'
          ? '<main>Expected company</main>'
          : page === '/challenge'
            ? '<title>Just a moment...</title><div id="cf-chl-widget">Expected company</div>'
            : page === '/script'
              ? '<script>"Expected company"</script><body>Loading</body>'
              : '<main>Wrong company</main>';
      res.end(JSON.stringify({ content, pageStatusCode: 200, url: body.url }));
    });
    const port = await listen(server);
    try {
      const fixtureFile = path.join(directory, 'fixtures.json');
      const output = path.join(directory, 'receipts');
      await writeFile(
        fixtureFile,
        JSON.stringify({
          name: 'Local scorer verification',
          source: 'local fixture',
          sourceCommit: 'test',
          targets: [
            'success',
            'challenge',
            'script',
            'missing',
            'error',
            'invalid',
          ].map((name) => ({
            name,
            url: `https://fixture.test/${name}`,
            containsText: 'Expected company',
            antibot: 'test-only',
          })),
        }),
      );
      await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/benchmark-waf.ts',
          `--fixtures=${fixtureFile}`,
          `--out=${output}`,
          `--service=http://127.0.0.1:${port}`,
          '--timeout=1000',
          '--wait=0',
          '--concurrency=8',
        ],
        { cwd: root, timeout: 10000 },
      );
      const report = JSON.parse(
        await readFile(path.join(output, 'report.json'), 'utf8'),
      );
      assert.equal(report.status, 'complete');
      assert.equal(report.concurrency, 8);
      assert.equal(report.timingIntegrity.valid, true);
      assert.deepEqual(report.timingIntegrity.gaps, []);
      assert.equal(report.timingIntegrity.maximumAllowedGapMs, 10000);
      assert.equal(requests, 6);
      assert.equal(report.expectedRequests, 6);
      assert.equal(report.overall.requests, 6);
      assert.equal(report.overall.frontierPasses, 3);
      assert.equal(report.overall.screenedPasses, 1);
      assert.equal(report.overall.failures.service_error, 1);
      assert.equal(report.overall.failures.challenge, 1);
      assert.equal(report.overall.failures.transport_error, 1);
      assert.equal(
        JSON.parse(await readFile(path.join(output, 'fixtures.json'), 'utf8'))
          .targets.length,
        6,
      );
      assert.equal(
        (await readFile(path.join(output, 'attempts.jsonl'), 'utf8'))
          .trim()
          .split('\n').length,
        6,
      );
      assert.equal((await readdir(path.join(output, 'evidence'))).length, 5);
    } finally {
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
