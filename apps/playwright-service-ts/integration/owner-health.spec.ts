import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startService, scrape, listen, closeServer } from './support';

type Counts = Record<string, number>;
const observer = (logs: string): Counts => {
  const lines = logs.split('\n').filter((l) => l.startsWith('OWNED_HEALTH '));
  assert.ok(lines.length);
  return JSON.parse(lines.at(-1)!.slice(13));
};
const until = async (
  condition: () => boolean,
  message: string,
  timeout = 10000,
) => {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test(
  'owned owner-health HTTP concurrency and resource ownership',
  { timeout: 180000 },
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
          path.join(os.tmpdir(), 'firecrawl-owned-health-'),
        );
        const controlFile = path.join(directory, 'control.json');
        const control = async (value: object) => {
          await writeFile(controlFile + '.next', JSON.stringify(value));
          await rename(controlFile + '.next', controlFile);
        };
        await control({});
        const token = 'owned-health-fixture';
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
              BROWSER_SERVICE_AUTH_TOKEN: token,
              OWNED_HEALTH_CONTROL_FILE: controlFile,
              NODE_OPTIONS:
                '--require=' +
                path.join(__dirname, 'fixtures/health-observer.cjs'),
            },
            { compiledEntrypoint: 'dist/api.js' },
          );
          const running = service;
          const counts = () => observer(running.logs());
          const getHealth = async (
            headers: Record<string, string> = {
              authorization: 'Bearer ' + token,
            },
          ) => {
            const r = await fetch(running.baseUrl + '/health', {
              headers,
              signal: AbortSignal.timeout(12000),
            });
            return { status: r.status, body: (await r.json()) as any };
          };
          await t.test(
            'eight workers share one real context/page and retain boot identity',
            async () => {
              const initial = counts();
              await control({ holdCreate: true });
              const pending = Array.from({ length: 8 }, () => getHealth());
              try {
                await until(
                  () => counts().healthRequests >= initial.healthRequests + 8,
                  'health requests did not arrive',
                );
                assert.equal(
                  counts().contextRequests - initial.contextRequests,
                  1,
                );
                await control({});
                const rows = await Promise.all(pending);
                assert.ok(rows.every((r) => r.status === 200));
                assert.equal(
                  new Set(rows.map((r) => r.body.ownerBootId)).size,
                  1,
                );
                assert.ok(
                  rows.every(
                    (r) =>
                      r.body.maxConcurrentPages === 1 &&
                      r.body.activePages === 0 &&
                      r.body.browserSessions === 0,
                  ),
                );
                const final = counts();
                assert.equal(
                  final.contextsCreated - initial.contextsCreated,
                  1,
                );
                assert.equal(final.pagesCreated - initial.pagesCreated, 1);
                assert.equal(final.pagesClosed - initial.pagesClosed, 1);
                assert.equal(final.contextsClosed - initial.contextsClosed, 1);
                assert.equal(final.contextsOpen, 0);
                // Completed healthy results are not cached by the owner.
                await getHealth();
                assert.equal(
                  counts().contextsCreated - final.contextsCreated,
                  1,
                );
              } finally {
                await control({});
                await Promise.allSettled(pending);
              }
            },
          );
          await t.test(
            'unauthorized and wrong-boot requests never allocate a probe',
            async () => {
              const initial = counts();
              assert.equal(
                (await getHealth({ authorization: 'Bearer invalid' })).status,
                401,
              );
              assert.equal(
                (
                  await getHealth({
                    authorization: 'Bearer ' + token,
                    'x-browser-owner': 'wrong-owner',
                  })
                ).status,
                409,
              );
              assert.equal(counts().contextRequests, initial.contextRequests);
            },
          );
          // Exercise the real delayed-allocation/cleanup paths once, plus Firefox's
          // page-allocation case, without multiplying the five-second deadline.
          if (engine === 'rebrowser' || engine === 'camoufox') {
            const fields =
              engine === 'rebrowser'
                ? ['holdCreate', 'holdPage', 'holdClose']
                : ['holdPage'];
            for (const field of fields)
              await t.test(
                field + ' times out once and drains before allocating again',
                async () => {
                  const initial = counts();
                  await control({ [field]: true });
                  const pending = Array.from({ length: 8 }, () => getHealth());
                  const rows = await Promise.all(pending);
                  assert.ok(
                    rows.every(
                      (r) =>
                        r.status === 503 &&
                        /health probe timed out/.test(r.body.error),
                    ),
                  );
                  assert.equal(
                    counts().contextRequests - initial.contextRequests,
                    1,
                  );
                  const again = await Promise.all(
                    Array.from({ length: 8 }, () => getHealth()),
                  );
                  assert.ok(again.every((r) => r.status === 503));
                  assert.equal(
                    counts().contextRequests - initial.contextRequests,
                    1,
                  );
                  await control({});
                  await until(
                    () => counts().contextsClosed > initial.contextsClosed,
                    'late context was not disposed',
                  );
                  assert.equal(counts().contextsOpen, 0);
                  if (field === 'holdCreate')
                    assert.equal(counts().pageRequests, initial.pageRequests);
                  if (field === 'holdPage')
                    assert.equal(counts().pagesClosed - initial.pagesClosed, 1);
                  assert.equal((await getHealth()).status, 200);
                },
              );
            await t.test(
              'a real close event settles health even when its acknowledgement is lost',
              async () => {
                const initial = counts();
                await control({ stallCloseAck: true });
                assert.equal((await getHealth()).status, 200);
                assert.equal(
                  counts().contextsClosed - initial.contextsClosed,
                  1,
                );
                assert.equal(counts().pagesClosed - initial.pagesClosed, 1);
                assert.equal(counts().contextsOpen, 0);
                await control({});
              },
            );
          }
          if (engine === 'rebrowser')
            await t.test(
              'capacity and session counts are assembled fresh after each shared probe',
              async () => {
                let release!: () => void;
                const received = new Promise<void>((resolve) => {
                  release = resolve;
                });
                let finish!: () => void;
                const fixture = http.createServer((_req, res) => {
                  finish = () =>
                    res.end('<main>Owned health capacity record</main>');
                  release();
                });
                const port = await listen(fixture);
                try {
                  const pending = fetch(running.baseUrl + '/scrape', {
                    method: 'POST',
                    headers: {
                      authorization: 'Bearer ' + token,
                      'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                      url: `http://127.0.0.1:${port}`,
                      timeout: 10000,
                      wait_until: 'domcontentloaded',
                      create_session: true,
                    }),
                  });
                  await received;
                  assert.equal((await getHealth()).body.activePages, 1);
                  finish();
                  const response = await pending;
                  const body = (await response.json()) as any;
                  assert.equal(response.status, 200);
                  assert.equal(body.pageStatusCode, 200);
                  const after = await getHealth();
                  assert.equal(after.body.activePages, 0);
                  assert.equal(after.body.browserSessions, 1);
                  assert.ok(body.sessionId);
                  const removed = await fetch(
                    running.baseUrl + '/sessions/' + body.sessionId,
                    {
                      method: 'DELETE',
                      headers: { authorization: 'Bearer ' + token },
                    },
                  );
                  assert.equal(removed.status, 204);
                  assert.equal((await getHealth()).body.browserSessions, 0);
                } finally {
                  finish?.();
                  await closeServer(fixture);
                }
              },
            );
        } finally {
          await control({});
          await service?.stop();
          await rm(directory, { recursive: true, force: true });
        }
      });
  },
);
