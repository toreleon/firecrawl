import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'bounded workflows and retained tabs through the browser HTTP service',
  { timeout: 60000 },
  async (t) => {
    const fixture = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/consent')
        return res.end(
          `<title>Product</title><main hidden id="product">Product 42</main><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.cookie='choice=necessary';document.querySelector('#product').hidden=false;document.querySelector('#onetrust-banner-sdk').remove()">Reject All</button></div>`,
        );
      if (req.url === '/tab')
        return res.end(
          `<title>Tab title</title><main id="step">Start</main><button id="next" onclick="sessionStorage.setItem('step','retained');window.liveStep=42;document.querySelector('#step').textContent='Continue 42'">Next</button>`,
        );
      if (req.url === '/human')
        return res.end(
          `<title>Security Verification</title><main>Verify you are human</main><button id="finish" onclick="document.title='Content';document.body.innerHTML='<main id=content>Verified product 42</main>'">Complete verification</button>`,
        );
      res.end('<title>Title-only assertion</title><main>Body content</main>');
    });
    const port = await listen(fixture);
    const origin = `http://127.0.0.1:${port}`;
    const service = await startService({ BROWSER_ENGINE: 'rebrowser' });
    try {
      await t.test(
        'consent applies a choice and unlocks content rather than hiding it',
        async () => {
          const result = await scrape(service.baseUrl, `${origin}/consent`, {
            consent: 'rejectNonEssential',
            check_selector: '#product',
            wait_for_text: 'Product 42',
            readiness_timeout: 2000,
          });
          assert.equal(result.body.readiness.satisfied, true);
          assert.equal(result.body.interaction.consent.outcome, 'applied');
          assert.match(result.body.content, /<main id="product">Product 42/);
        },
      );
      await t.test(
        'title and body readiness are explicitly different',
        async () => {
          const body = await scrape(service.baseUrl, origin, {
            wait_for_text: 'Title-only assertion',
            readiness_timeout: 100,
          });
          assert.equal(body.body.readiness.satisfied, false);
          const title = await scrape(service.baseUrl, origin, {
            wait_for_text: 'Title-only assertion',
            readiness_scope: 'title',
            readiness_timeout: 100,
          });
          assert.equal(title.body.readiness.satisfied, true);
        },
      );
      await t.test(
        'retained page continues without navigation and rejects implicit retries',
        async () => {
          const first = await scrape(service.baseUrl, `${origin}/tab`, {
            create_session: true,
            session_mode: 'workflow',
            actions: [{ type: 'click', selector: '#next' }],
            wait_for_text: 'Continue 42',
          });
          const token = first.body.sessionId;
          assert.match(token, /^[a-f0-9]{64}$/);
          const second = await scrape(service.baseUrl, `${origin}/tab`, {
            session_id: token,
            session_mode: 'workflow',
            continue_session: true,
            wait_for_text: 'Continue 42',
          });
          assert.equal(second.body.readiness.satisfied, true);
          assert.equal(second.body.diagnostics.navigations.length, 0);
          const invalid = await scrape(service.baseUrl, `${origin}/tab`, {
            session_id: token,
            session_mode: 'workflow',
            continue_session: true,
            max_attempts: 2,
          });
          assert.equal(invalid.status, 400);
          await fetch(`${service.baseUrl}/sessions/${token}`, {
            method: 'DELETE',
          });
        },
      );
      await t.test(
        'page-scoped handoff input and resume share the retained tab',
        async () => {
          const first = await scrape(service.baseUrl, `${origin}/human`, {
            create_session: true,
            session_mode: 'workflow',
          });
          const token = first.body.sessionId;
          assert.equal(first.body.interaction.state, 'HUMAN_REQUIRED');
          const snapshot = await fetch(
            `${service.baseUrl}/sessions/${token}/snapshot`,
          );
          assert.equal(snapshot.status, 200);
          const view: any = await snapshot.json();
          assert.ok(view.image.length > 50);
          const input = await fetch(
            `${service.baseUrl}/sessions/${token}/input`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'key', key: 'Tab' }),
            },
          );
          assert.equal(input.status, 200);
          await fetch(`${service.baseUrl}/sessions/${token}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'key', key: 'Enter' }),
          });
          const resumed = await scrape(service.baseUrl, `${origin}/human`, {
            session_id: token,
            session_mode: 'workflow',
            continue_session: true,
            wait_for_text: 'Verified product 42',
          });
          assert.equal(resumed.body.interaction.state, 'CONTENT_READY');
          assert.equal(resumed.body.readiness.satisfied, true);
          await fetch(`${service.baseUrl}/sessions/${token}`, {
            method: 'DELETE',
          });
        },
      );
      await t.test(
        'unsupported actions and stale browser-owner identity fail before navigation',
        async () => {
          const invalid = await scrape(service.baseUrl, origin, {
            actions: [{ type: 'executeJavascript', script: '1+1' }],
          });
          assert.equal(invalid.status, 400);
          const stale = await fetch(`${service.baseUrl}/scrape`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-browser-owner': 'previous-process',
            },
            body: JSON.stringify({ url: origin }),
          });
          assert.equal(stale.status, 409);
        },
      );
    } finally {
      await service.stop();
      await closeServer(fixture);
    }
  },
);
