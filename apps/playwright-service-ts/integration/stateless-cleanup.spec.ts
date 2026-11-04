import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startService, listen, closeServer } from './support';

const until = async (condition: () => boolean) => {
  const end = Date.now() + 10000;
  while (!condition()) {
    assert.ok(Date.now() < end, 'owned context did not finish disposal');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// The preload wraps only the owned service's real browser commands. All pages
// are loopback fixtures, and Docker's network-none boundary denies public egress.
test(
  'stateless cleanup keeps capacity until actual context disposal',
  { timeout: 120000 },
  async (t) => {
    const engines =
      process.env.TEST_WEBKIT === 'true'
        ? ['webkit']
        : [
            'playwright',
            'patchright',
            'rebrowser',
            ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
          ];
    for (const engine of engines)
      await t.test(engine, async (t) => {
        const directory = await mkdtemp(
          path.join(os.tmpdir(), 'firecrawl-owned-disposal-'),
        );
        const controlFile = path.join(directory, 'control.json');
        const control = async (value: object) => {
          await writeFile(controlFile + '.next', JSON.stringify(value));
          await rename(controlFile + '.next', controlFile);
        };
        await control({});
        const fixture = http.createServer((_req, res) =>
          res.end(
            '<!doctype html><main>Owned stateless disposal record 42</main>',
          ),
        );
        const port = await listen(fixture);
        let service: Awaited<ReturnType<typeof startService>> | undefined;
        try {
          service = await startService(
            {
              BROWSER_ENGINE: engine,
              BROWSER_CHANNEL: ['webkit', 'camoufox'].includes(engine)
                ? ''
                : 'chromium',
              BROWSER_HEADLESS: engine === 'webkit' ? 'false' : 'true',
              MAX_CONCURRENT_PAGES: '1',
              OWNED_HEALTH_CONTROL_FILE: controlFile,
              NODE_OPTIONS:
                '--require=' +
                path.join(__dirname, 'fixtures/health-observer.cjs'),
            },
            { compiledEntrypoint: 'dist/api.js' },
          );
          const running = service;
          const counts = () => {
            const lines = running
              .logs()
              .split('\n')
              .filter((l) => l.startsWith('OWNED_HEALTH '));
            return JSON.parse(lines.at(-1)!.slice(13)) as Record<
              string,
              number
            >;
          };
          const scrape = async (timeout = 10000) => {
            const response = await fetch(running.baseUrl + '/scrape', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                url: `http://127.0.0.1:${port}`,
                timeout,
                wait_until: 'domcontentloaded',
                wait_after_load: 0,
                max_attempts: 1,
              }),
              signal: AbortSignal.timeout(15000),
            });
            return {
              status: response.status,
              body: (await response.json()) as any,
            };
          };
          const health = async () =>
            (await fetch(running.baseUrl + '/health')).json() as Promise<any>;

          await t.test(
            'a close event confirms disposal despite a lost command acknowledgement',
            async () => {
              const initial = counts();
              try {
                await control({ stallCloseAck: true });
                const result = await scrape();
                assert.equal(result.status, 200);
                const cleanup = result.body.diagnostics.attempts.at(-1);
                assert.equal(cleanup.pageClosed, true);
                assert.equal(cleanup.contextClosed, true);
                assert.equal(cleanup.cleanupFinished, true);
                assert.equal(
                  counts().contextsClosed - initial.contextsClosed,
                  1,
                );
                assert.equal(counts().closeCalls - initial.closeCalls, 1);
                assert.equal(counts().contextsOpen, 0);
              } finally {
                await control({});
              }
              assert.equal((await health()).activePages, 0);
            },
          );

          for (const field of ['holdClose', 'holdCreate'])
            await t.test(
              field +
                ' does not allow a second context before the first is disposed',
              async () => {
                const initial = counts();
                try {
                  await control({ [field]: true });
                  const result = await scrape(
                    field === 'holdCreate' ? 200 : 10000,
                  );
                  if (field === 'holdClose') {
                    assert.equal(result.status, 200);
                    const cleanup = result.body.diagnostics.attempts.at(-1);
                    assert.equal(cleanup.contextClosed, false);
                    assert.equal(cleanup.cleanupFinished, false);
                    // Outlive the outer handler's additional bounded cleanup wait.
                    // The original operation must still own admission after that.
                    await new Promise((resolve) => setTimeout(resolve, 1200));
                    assert.equal(counts().contextsOpen, 1);
                    assert.equal(counts().closeCalls - initial.closeCalls, 1);
                  } else {
                    assert.equal(result.status, 500);
                    assert.equal(result.body.errorCode, 'SCRAPE_TIMEOUT');
                  }
                  const queued = await scrape(200);
                  assert.equal(queued.status, 500);
                  assert.equal(queued.body.errorCode, 'SCRAPE_TIMEOUT');
                  assert.match(queued.body.error, /browser capacity/);
                  assert.equal(
                    counts().contextRequests - initial.contextRequests,
                    1,
                  );
                  await control({});
                  await until(
                    () =>
                      counts().contextsClosed === initial.contextsClosed + 1,
                  );
                  assert.equal(counts().contextsOpen, 0);
                  const recovered = await scrape();
                  assert.equal(recovered.status, 200);
                  assert.equal(
                    recovered.body.diagnostics.attempts.at(-1).contextClosed,
                    true,
                  );
                  assert.equal((await health()).activePages, 0);
                } finally {
                  await control({});
                  await until(() => counts().contextsOpen === 0);
                }
              },
            );
        } finally {
          await control({});
          await service?.stop();
          await closeServer(fixture);
          await rm(directory, { recursive: true, force: true });
        }
      });
  },
);
