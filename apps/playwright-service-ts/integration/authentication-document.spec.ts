import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';

test(
  'authentication state uses the final document path rather than query examples or partial names',
  { timeout: 60000 },
  async (t) => {
    const fixture = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture.test');
      if (url.pathname === '/product') {
        res.writeHead(302, { location: '/login.html?from=%2Fproduct' });
        return res.end();
      }
      res.setHeader('content-type', 'text/html');
      if (['/login.html', '/accounts/login/'].includes(url.pathname))
        return res.end(
          '<main><h1>Sign in / Register</h1><label>Email or phone number<input autocomplete="username"></label><button>Continue</button></main>',
        );
      res.end(
        '<main><h1>Public account security guide</h1><p>This is a public article about sign in flows.</p></main>',
      );
    });
    const port = await listen(fixture);
    try {
      for (const engine of [
        'rebrowser',
        ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
      ])
        await t.test(engine, async (t) => {
          const service = await startService({
            BROWSER_ENGINE: engine,
            ...(engine === 'camoufox' ? { BROWSER_CHANNEL: '' } : {}),
          });
          try {
            for (const [path, state] of [
              ['/product', 'AUTH_REQUIRED'],
              ['/accounts/login/?next=/public', 'AUTH_REQUIRED'],
              ['/article?example=/accounts/login', 'CONTENT_READY'],
              ['/articles/accounts/login-guide', 'CONTENT_READY'],
              ['/docs/login.html', 'CONTENT_READY'],
            ])
              await t.test(path, async () => {
                const result = await scrape(
                  service.baseUrl,
                  `http://127.0.0.1:${port}${path}`,
                  {
                    workflow: 'auto',
                    wait_until: 'domcontentloaded',
                    wait_after_load: 0,
                    max_attempts: 1,
                  },
                );
                assert.equal(result.status, 200);
                assert.equal(result.body.pageStatusCode, 200);
                assert.equal(result.body.readiness.satisfied, true);
                assert.equal(result.body.interaction.state, state);
                assert.equal(result.body.diagnostics.attempts.length, 1);
                assert.equal(
                  result.body.diagnostics.attempts[0].pageClosed,
                  true,
                  JSON.stringify(result.body.diagnostics),
                );
                if (path === '/product') {
                  assert.equal(
                    new URL(result.body.url).pathname,
                    '/login.html',
                  );
                  assert.match(
                    result.body.renderedText,
                    /Email or phone number/,
                  );
                } else if (state === 'CONTENT_READY')
                  assert.match(
                    result.body.renderedText,
                    /Public account security guide/,
                  );
              });
          } finally {
            await service.stop();
          }
        });
    } finally {
      await closeServer(fixture);
    }
  },
);
