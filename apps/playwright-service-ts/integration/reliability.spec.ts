import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'readiness, final-document metadata, sessions and bounded recovery through HTTP',
  { timeout: 60000 },
  async (t) => {
    const counts = new Map<string, number>();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.test');
      const key = url.pathname + url.search;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (url.pathname === '/stall') return;
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/redirect-late') {
        if (url.searchParams.has('from-challenge'))
          res.setHeader('cf-mitigated', 'challenge');
        return res.end(
          `<title>Initial document</title><script>setTimeout(() => location.href='/final?status=${url.searchParams.get('status') ?? '403'}', 120)</script>`,
        );
      }
      if (url.pathname === '/final') {
        res.statusCode = Number(url.searchParams.get('status'));
        if (res.statusCode === 403) res.setHeader('cf-mitigated', 'challenge');
        return res.end('<main id="final">Final document</main>');
      }
      if (url.pathname === '/hydrate')
        return res.end(
          '<main>Loading</main><script>setTimeout(()=>document.body.innerHTML=\'<main id="ready">Expected late company</main>\',700)</script>',
        );
      if (url.pathname === '/set-cookie') {
        res.setHeader('set-cookie', 'workflow=private; Path=/');
        return res.end('<main>Session established</main>');
      }
      if (url.pathname === '/cookie')
        return res.end(`<main>${req.headers.cookie ?? 'no-cookie'}</main>`);
      if (url.pathname === '/flaky' && counts.get(key) === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '0');
        return res.end('Limited once');
      }
      if (url.pathname === '/deny' || url.pathname === '/backoff') {
        res.statusCode = url.pathname === '/deny' ? 403 : 503;
        res.setHeader('retry-after', '30');
        return res.end('Unavailable');
      }
      if (url.pathname === '/slow')
        return setTimeout(() => res.end('<main>Slow content</main>'), 800);
      res.end('<main>Expected company</main>');
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const service = await startService({
      BROWSER_ENGINE: 'rebrowser',
      MAX_CONCURRENT_PAGES: '2',
      MAX_BROWSER_SESSIONS: '2',
      BROWSER_SESSION_TTL_MS: '3000',
    });
    try {
      await t.test(
        'timed-out navigation retains its phase and network observations',
        async () => {
          const failed = await scrape(service.baseUrl, `${origin}/stall`, {
            timeout: 1000,
            wait_after_load: 0,
            max_attempts: 1,
          });
          assert.equal(failed.body.errorCode, 'SCRAPE_TIMEOUT');
          assert.equal(failed.body.diagnostics.attempts.length, 1);
          const attempt = failed.body.diagnostics.attempts[0];
          assert.equal(attempt.document.phase, 'navigation');
          assert.ok(Array.isArray(attempt.document.recentFailedRequests));
        },
      );
      await t.test(
        'delayed client redirects retain the final status and challenge headers',
        async () => {
          const denied = await scrape(
            service.baseUrl,
            `${origin}/redirect-late`,
            { wait_after_load: 350 },
          );
          assert.equal(denied.body.url, `${origin}/final?status=403`);
          assert.equal(denied.body.pageStatusCode, 403);
          assert.equal(denied.body.botDetection.provider, 'cloudflare');
          const cleared = await scrape(
            service.baseUrl,
            `${origin}/redirect-late?status=200&from-challenge=1`,
            { wait_after_load: 350 },
          );
          assert.equal(cleared.body.pageStatusCode, 200);
          assert.equal(cleared.body.botDetection, undefined);
          assert.equal(cleared.body.pageError, undefined);
          assert.equal(cleared.body.diagnostics.navigations.length, 2);
        },
      );
      await t.test(
        'content waits handle late hydration and preserve bounded missing-content evidence',
        async () => {
          const ready = await scrape(service.baseUrl, `${origin}/hydrate`, {
            wait_after_load: 0,
            wait_until: 'domcontentloaded',
            wait_for_text: 'Expected late company',
            readiness_timeout: 2000,
          });
          assert.equal(ready.body.readiness.satisfied, true);
          assert.match(ready.body.content, /id="ready"/);
          const start = Date.now();
          const missing = await scrape(service.baseUrl, origin, {
            timeout: 1000,
            wait_after_load: 0,
            wait_for_text: 'Absent content',
            readiness_timeout: 10000,
          });
          assert.equal(missing.body.readiness.satisfied, false);
          assert.equal(missing.body.errorCode, 'CONTENT_NOT_READY');
          assert.match(missing.body.content, /Expected company/);
          assert.ok(Date.now() - start < 2000);
        },
      );
      await t.test(
        'opt-in sessions preserve cookies with origin/profile isolation, exclusivity and deletion',
        async () => {
          const created = await scrape(
            service.baseUrl,
            `${origin}/set-cookie`,
            { create_session: true, wait_after_load: 0 },
          );
          const token = created.body.sessionId;
          assert.match(token, /^[a-f0-9]{64}$/);
          const reused = await scrape(service.baseUrl, `${origin}/cookie`, {
            session_id: token,
            wait_after_load: 0,
          });
          assert.match(reused.body.content, /workflow=private/);
          const fresh = await scrape(service.baseUrl, `${origin}/cookie`, {
            wait_after_load: 0,
          });
          assert.match(fresh.body.content, /no-cookie/);
          const mismatch = await scrape(service.baseUrl, `${origin}/cookie`, {
            session_id: token,
            headers: { 'User-Agent': 'different' },
            wait_after_load: 0,
          });
          assert.equal(mismatch.body.errorCode, 'SESSION_MISMATCH');
          const otherOrigin = await scrape(
            service.baseUrl,
            `http://localhost:${port}/cookie`,
            { session_id: token, wait_after_load: 0 },
          );
          assert.equal(otherOrigin.body.errorCode, 'SESSION_MISMATCH');
          const slow = scrape(service.baseUrl, `${origin}/slow`, {
            session_id: token,
            wait_after_load: 0,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const busy = await scrape(service.baseUrl, origin, {
            session_id: token,
            wait_after_load: 0,
          });
          assert.equal(busy.body.errorCode, 'SESSION_BUSY');
          await slow;
          assert.equal(
            (
              await fetch(`${service.baseUrl}/sessions/${token}`, {
                method: 'DELETE',
              })
            ).status,
            204,
          );
          const expired = await scrape(service.baseUrl, origin, {
            session_id: token,
            wait_after_load: 0,
          });
          assert.equal(expired.body.errorCode, 'SESSION_EXPIRED');
          assert.doesNotMatch(service.logs(), new RegExp(token));
        },
      );
      await t.test(
        'session capacity and expiry release browser resources',
        async () => {
          const one = await scrape(service.baseUrl, origin, {
            create_session: true,
            wait_after_load: 0,
          });
          const two = await scrape(service.baseUrl, origin, {
            create_session: true,
            wait_after_load: 0,
          });
          const limited = await scrape(service.baseUrl, origin, {
            create_session: true,
            wait_after_load: 0,
          });
          assert.equal(limited.status, 429);
          assert.equal(limited.body.errorCode, 'SESSION_LIMIT');
          await new Promise((resolve) => setTimeout(resolve, 3200));
          const gone = await scrape(service.baseUrl, origin, {
            session_id: one.body.sessionId,
            wait_after_load: 0,
          });
          assert.equal(gone.body.errorCode, 'SESSION_EXPIRED');
          const health = await (
            await fetch(`${service.baseUrl}/health`)
          ).json();
          assert.equal(health.browserSessions, 0);
          assert.equal(health.activePages, 0);
        },
      );
      await t.test(
        'recovery is opt-in, counts attempts, respects Retry-After and never retries hard denials',
        async () => {
          const recovered = await scrape(
            service.baseUrl,
            `${origin}/flaky?retry`,
            { max_attempts: 2, wait_after_load: 0 },
          );
          assert.equal(recovered.body.pageStatusCode, 200);
          assert.equal(recovered.body.diagnostics.attempts.length, 2);
          assert.equal(counts.get('/flaky?retry'), 2);
          const firstOnly = await scrape(
            service.baseUrl,
            `${origin}/flaky?default`,
            { wait_after_load: 0 },
          );
          assert.equal(firstOnly.body.pageStatusCode, 429);
          assert.equal(counts.get('/flaky?default'), 1);
          const backoff = await scrape(service.baseUrl, `${origin}/backoff`, {
            timeout: 1000,
            max_attempts: 3,
            wait_after_load: 0,
          });
          assert.equal(backoff.body.pageStatusCode, 503);
          assert.equal(backoff.body.diagnostics.attempts.length, 1);
          const denied = await scrape(service.baseUrl, `${origin}/deny`, {
            max_attempts: 3,
            wait_after_load: 0,
          });
          assert.equal(denied.body.diagnostics.attempts.length, 1);
        },
      );
      await t.test(
        'queue waits share the deadline and cancelled waiters do not leak permits',
        async () => {
          const slow = [1, 2].map((n) =>
            scrape(service.baseUrl, `${origin}/slow?n=${n}`, {
              wait_after_load: 0,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          const queued = await scrape(service.baseUrl, origin, {
            timeout: 100,
            wait_after_load: 0,
          });
          assert.equal(queued.body.errorCode, 'SCRAPE_TIMEOUT');
          await Promise.all(slow);
          const healthy = await (
            await fetch(`${service.baseUrl}/health`)
          ).json();
          assert.equal(healthy.activePages, 0);
          assert.equal(
            (await scrape(service.baseUrl, origin)).body.pageStatusCode,
            200,
          );
        },
      );
    } finally {
      await service.stop();
      await closeServer(server);
    }
  },
);
