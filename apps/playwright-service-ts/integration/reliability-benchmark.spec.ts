import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listen, closeServer } from './support';

test(
  'paired CLI records all profiles and redacts session capabilities from retained evidence',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'firecrawl-reliability-'),
    );
    const token = 'a'.repeat(64);
    let reused = 0;
    let deleted = 0;
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health')
        return res.end(JSON.stringify({ status: 'healthy' }));
      if (req.method === 'DELETE') {
        deleted++;
        return res.end('{}');
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.session_id) {
        assert.equal(body.session_id, token);
        reused++;
      }
      const expected = body.url.includes('arxiv')
        ? 'Computer Science &gt; Computation and Language'
        : 'The library for web and native user interfaces';
      res.end(
        JSON.stringify({
          content: `<main>${expected}</main>`,
          pageStatusCode: 200,
          diagnostics: { attempts: [{}] },
          ...(body.create_session || body.session_id
            ? { sessionId: token }
            : {}),
        }),
      );
    });
    const port = await listen(server);
    try {
      const output = path.join(directory, 'run');
      const url = `http://127.0.0.1:${port}`;
      await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/benchmark-reliability.ts',
          '--targets=arxiv,github',
          `--legacy=${url}`,
          `--revised=${url}`,
          `--unfiltered=${url}`,
          `--out=${output}`,
        ],
        { cwd: path.resolve(__dirname, '..'), timeout: 12000 },
      );
      const report = JSON.parse(
        await readFile(path.join(output, 'report.json'), 'utf8'),
      );
      assert.equal(report.status, 'complete');
      assert.equal(report.attempts.length, 20);
      assert.equal(
        new Set(
          report.attempts.map(
            (row: any) => `${row.profile}/${row.target}/${row.attempt}`,
          ),
        ).size,
        20,
      );
      assert.equal(report.timingIntegrity.valid, true);
      assert.equal(reused, 2);
      assert.equal(deleted, 2);
      const evidence = await readdir(path.join(output, 'evidence'));
      assert.equal(evidence.length, 20);
      for (const file of evidence)
        assert.ok(
          !(
            await readFile(path.join(output, 'evidence', file), 'utf8')
          ).includes(token),
        );
      for (const result of Object.values(report.byProfile) as any[]) {
        assert.equal(result.requests, 4);
        assert.equal(result.normalizedPasses, 4);
        assert.equal(result.frontierPasses, 2);
      }
    } finally {
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
