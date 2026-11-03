import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listen, closeServer } from './support';
import { requestApiScrape, sha256 } from '../helpers/api-benchmark';
import { scoreObservation } from '../helpers/waf-benchmark';

test(
  'paired API CLI enforces eight in-flight requests, fresh options, budgets, honest failures and credential redaction',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'firecrawl-api-benchmark-'));
    const secret = 'benchmark-fixture-secret';
    let active = 0,
      peak = 0,
      requests = 0;
    const activeByProfile: Record<string, number> = {},
      peakByProfile: Record<string, number> = {};
    const received: { profile: string; target: string }[] = [];
    const server = http.createServer(async (req, res) => {
      active++;
      peak = Math.max(peak, active);
      requests++;
      const profile = req.url!.split('/')[1];
      activeByProfile[profile] = (activeByProfile[profile] ?? 0) + 1;
      peakByProfile[profile] = Math.max(
        peakByProfile[profile] ?? 0,
        activeByProfile[profile],
      );
      assert.equal(
        req.headers.authorization,
        profile === 'hosted' ? `Bearer ${secret}` : undefined,
      );
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(body.formats, ['rawHtml', 'markdown']);
      assert.equal(body.maxAge, 0);
      assert.equal(body.storeInCache, false);
      assert.equal(body.onlyMainContent, false);
      assert.equal(body.waitFor, 0);
      assert.equal(body.waitForText, undefined);
      const target = new URL(body.url).pathname.slice(1);
      received.push({ profile, target });
      await new Promise((resolve) => setTimeout(resolve, 250));
      active--;
      activeByProfile[profile]--;
      res.setHeader('content-type', 'application/json');
      if (target === 'invalid') return res.end('not JSON');
      res.end(
        JSON.stringify({
          success: true,
          data: {
            rawHtml: `<main>Expected company ${secret}</main>`,
            markdown: 'Expected company',
            metadata: {
              ...(target !== 'missing-status' && {
                statusCode: target === 'denied' ? 403 : 200,
              }),
              creditsUsed: 1,
              cacheState: 'miss',
            },
          },
        }),
      );
    });
    const port = await listen(server);
    const root = path.resolve(__dirname, '..');
    const fixturePath = path.join(dir, 'fixtures.json'),
      profilePath = path.join(dir, 'profiles.json'),
      output = path.join(dir, 'run');
    const targets = ['success', 'denied', 'missing-status', 'invalid'];
    const bytes = JSON.stringify({
      name: 'fixture',
      targets: targets.map((name) => ({
        name,
        url: `https://fixture.test/${name}`,
        containsText: 'Expected company',
      })),
    });
    await writeFile(fixturePath, bytes);
    await writeFile(
      profilePath,
      JSON.stringify([
        { name: 'fork', baseUrl: `http://127.0.0.1:${port}/fork` },
        {
          name: 'hosted',
          baseUrl: `http://127.0.0.1:${port}/hosted`,
          apiKeyEnv: 'BENCHMARK_FIXTURE_KEY',
        },
      ]),
    );
    const args = [
      '--import',
      'tsx',
      'scripts/benchmark-api.ts',
      `--profiles=${profilePath}`,
      `--fixtures=${fixturePath}`,
      `--out=${output}`,
      '--concurrency=8',
      '--delay=0',
      '--timeout=2000',
    ];
    const options = {
      cwd: root,
      timeout: 15000,
      env: { ...process.env, BENCHMARK_FIXTURE_KEY: secret },
    };
    try {
      const execution = await promisify(execFile)(
        process.execPath,
        args,
        options,
      );
      assert.equal(execution.stdout.includes(secret), false);
      assert.equal(peak, 8);
      assert.equal(requests, 8);
      for (const target of targets)
        assert.deepEqual(
          received
            .filter((r) => r.target === target)
            .map((r) => r.profile)
            .sort(),
          ['fork', 'hosted'],
        );
      const reportText = await readFile(
        path.join(output, 'report.json'),
        'utf8',
      );
      assert.equal(reportText.includes(secret), false);
      const report = JSON.parse(reportText);
      assert.equal(report.status, 'complete');
      assert.equal(report.fixtureSha256, sha256(bytes));
      assert.equal(report.attempts.length, 8);
      assert.equal(report.timingIntegrity.valid, true);
      for (const target of targets)
        assert.deepEqual(
          report.attempts
            .filter((r: any) => r.target === target)
            .sort((a: any, b: any) =>
              a.evidenceFile.localeCompare(b.evidenceFile),
            )
            .map((r: any) => r.profile),
          targets.indexOf(target) % 2 === 0
            ? ['fork', 'hosted']
            : ['hosted', 'fork'],
        );
      const fixtures = JSON.parse(bytes);
      for (const row of report.attempts) {
        const raw = await readFile(path.join(output, row.evidenceFile), 'utf8');
        assert.equal(raw.includes(secret), false);
        const evidence = JSON.parse(raw);
        assert.equal(
          row.payloadSha256,
          sha256(JSON.stringify(evidence.payload)),
        );
        assert.equal(
          scoreObservation(
            fixtures.targets.find((t: any) => t.name === row.target),
            evidence.observation,
          ).normalizedPass,
          row.normalizedPass,
        );
      }
      for (const p of Object.values(report.byProfile) as any[]) {
        assert.equal(p.overall.requests, 4);
        assert.equal(p.overall.normalizedPasses, 1);
        assert.equal(p.markdownMarkerPasses, 3);
        assert.equal(p.returnedCreditsUsed, 3);
        assert.equal(p.unknownCreditsCount, 1);
        assert.equal(p.overall.failures.target_status_403, 1);
        assert.equal(p.overall.failures.target_status_missing, 2);
      }
      assert.equal((await readdir(path.join(output, 'evidence'))).length, 8);
      await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/audit-api-benchmark.ts',
          `--run=${output}`,
        ],
        options,
      );
      const audit = JSON.parse(
        await readFile(path.join(output, 'score-replay-audit.json'), 'utf8'),
      );
      assert.equal(audit.allScoresReplay, true);
      assert.equal(audit.attempts, 8);
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [
            ...args.filter((x) => !x.startsWith('--out=')),
            `--out=${output}-budget`,
            '--max-requests=7',
          ],
          options,
        ),
      );
      assert.equal(
        requests,
        8,
        'over-budget invocation must dispatch zero requests',
      );
      const capped = JSON.parse(await readFile(profilePath, 'utf8')).map(
        (p: any) => ({ ...p, maxConcurrentRequests: 2 }),
      );
      await writeFile(profilePath, JSON.stringify(capped));
      peak = 0;
      for (const k of Object.keys(peakByProfile)) peakByProfile[k] = 0;
      await promisify(execFile)(
        process.execPath,
        [
          ...args.filter((a) => !a.startsWith('--out=')),
          `--out=${output}-limited`,
        ],
        options,
      );
      assert.equal(peak, 4);
      assert.deepEqual(peakByProfile, { fork: 2, hosted: 2 });
      assert.equal(requests, 16);
      const limited = JSON.parse(
        await readFile(path.join(output + '-limited', 'report.json'), 'utf8'),
      );
      assert.ok(limited.attempts.some((r: any) => r.queueWaitMs > 100));
      await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/audit-api-benchmark.ts',
          `--run=${output}-limited`,
        ],
        options,
      );
      const limitedAudit = JSON.parse(
        await readFile(
          path.join(output + '-limited', 'score-replay-audit.json'),
          'utf8',
        ),
      );
      assert.equal(limitedAudit.profileConcurrencyLimitsChecked, 2);
    } finally {
      await closeServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'API credentials are not forwarded on redirects, and body-read timeout retains HTTP status',
  { timeout: 10000 },
  async () => {
    let redirected = 0;
    const destination = http.createServer((_req, res) => {
      redirected++;
      res.end('{}');
    });
    const to = await listen(destination);
    const server = http.createServer((req, res) => {
      if (req.url!.startsWith('/redirect')) {
        res.writeHead(302, { location: `http://127.0.0.1:${to}/v2/scrape` });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      }
    });
    const from = await listen(server);
    try {
      const result = await requestApiScrape(
        { name: 'test', baseUrl: `http://127.0.0.1:${from}/redirect` },
        'https://fixture.test',
        1000,
        'test-secret',
      );
      assert.equal(redirected, 0);
      assert.ok(result.observation.transportError);
      const stalled = await requestApiScrape(
        { name: 'test', baseUrl: `http://127.0.0.1:${from}/stall` },
        'https://fixture.test',
        100,
        'test-secret',
      );
      assert.equal(stalled.observation.apiStatus, 200);
      assert.equal(stalled.observation.timedOut, true);
    } finally {
      await closeServer(server);
      await closeServer(destination);
    }
  },
);

test(
  'API deadline settles a body source that ignores abort and cancels the reader',
  { timeout: 10000 },
  async () => {
    const original = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    try {
      const result = await requestApiScrape(
        { name: 'owned', baseUrl: 'http://127.0.0.1:1' },
        'https://fixture.test',
        50,
      );
      assert.equal(result.observation.apiStatus, 200);
      assert.equal(result.observation.timedOut, true);
      assert.equal(result.payload, null);
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = original;
    }
  },
);
