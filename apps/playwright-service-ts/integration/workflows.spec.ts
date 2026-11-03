import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, closeServer, startService, scrape } from './support';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { applyWorkflow } from '../helpers/workflows';
import { Deadline } from '../helpers/scrape-control';
import { shouldBlockAdRequest } from '../helpers/resource-policy';
import { scrapePage } from '../helpers/scrape-page';

test(
  'Amazon answer-free continuation keeps cookies and returns to the exact requested product',
  { timeout: 20000 },
  async () => {
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'rebrowser',
        BROWSER_CHANNEL: 'chromium',
        BROWSER_HEADLESS: 'true',
      }),
    );
    const target = 'https://www.amazon.com/Test/dp/B000000042';
    const form =
      '<h4>Click the button below to continue shopping</h4><form method="get" action="/errors_page/validateCaptcha"><input type="hidden" name="amzn" value="opaque"><input type="hidden" name="amzn-r" value="opaque"><input type="hidden" name="field-keywords" value="server"><button type="submit">Continue shopping</button></form>';
    try {
      const page = await browser.newPage();
      await page.context().setOffline(true);
      let submitted = 0,
        productRequests = 0;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/errors_page/validateCaptcha') {
          submitted++;
          assert.equal(route.request().method(), 'GET');
          assert.equal(url.searchParams.get('field-keywords'), 'server');
          return route.fulfill({
            contentType: 'text/html',
            headers: {
              'set-cookie':
                'continuation=accepted; Path=/; Secure; SameSite=Lax',
            },
            body: '<script>location.replace("https://www.amazon.com/")</script>',
          });
        }
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<main>Storefront</main>',
          });
        assert.equal(url.href, target);
        productRequests++;
        return route.fulfill({
          contentType: 'text/html',
          body: route
            .request()
            .headers()
            .cookie?.includes('continuation=accepted')
            ? '<main>Requested product 42</main>'
            : form,
        });
      });
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      const workflow = await applyWorkflow(page, 'auto', new Deadline(10000));
      assert.equal(submitted, 1);
      assert.equal(productRequests, 2);
      assert.equal(page.url(), target);
      assert.match(
        await page.locator('body').innerText(),
        /Requested product 42/,
      );
      assert.equal(
        workflow.steps[0].outcome,
        'submitted-and-returned-to-product',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'Amazon continuation does not answer puzzles and rejects a different product redirect',
  { timeout: 20000 },
  async () => {
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'rebrowser',
        BROWSER_CHANNEL: 'chromium',
        BROWSER_HEADLESS: 'true',
      }),
    );
    const target = 'https://www.amazon.com/Test/dp/B000000042';
    const form =
      '<h4>Click the button below to continue shopping</h4><form method="get" action="/errors_page/validateCaptcha"><input type="hidden" name="amzn" value="opaque"><input type="hidden" name="amzn-r" value="opaque"><input type="hidden" name="field-keywords" value="server"><button type="submit">Continue shopping</button></form>';
    try {
      for (const puzzle of [true, false]) {
        const page = await browser.newPage();
        await page.context().setOffline(true);
        let submitted = 0;
        await page.route('**/*', (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/errors_page/validateCaptcha') {
            submitted++;
            return route.fulfill({
              contentType: 'text/html',
              body: '<script>location.replace("https://www.amazon.com/Other/dp/B000000043")</script>',
            });
          }
          return route.fulfill({
            contentType: 'text/html',
            body:
              url.href === target
                ? form.replace(
                    '</form>',
                    puzzle
                      ? '<input id="captchacharacters" type="text"></form>'
                      : '</form>',
                  )
                : '<main>Other product</main>',
          });
        });
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        if (puzzle) {
          assert.equal(
            (await applyWorkflow(page, 'auto', new Deadline(5000))).steps
              .length,
            0,
          );
          assert.equal(submitted, 0);
        } else {
          await assert.rejects(
            applyWorkflow(page, 'auto', new Deadline(5000)),
            (e: any) => e.code === 'WORKFLOW_NAVIGATION_MISMATCH',
          );
          assert.equal(submitted, 1);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'capture rejects a late redirect to a different Amazon product after continuation',
  { timeout: 15000 },
  async () => {
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'rebrowser',
        BROWSER_CHANNEL: 'chromium',
        BROWSER_HEADLESS: 'true',
      }),
    );
    try {
      const page = await browser.newPage();
      await page.context().setOffline(true);
      let submitted = false;
      const target = 'https://www.amazon.com/Test/dp/B000000042';
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/errors_page/validateCaptcha') {
          submitted = true;
          return route.fulfill({
            contentType: 'text/html',
            body: '<script>location.replace("https://www.amazon.com/")</script>',
          });
        }
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<main>Storefront</main>',
          });
        if (url.href === target)
          return route.fulfill({
            contentType: 'text/html',
            body: submitted
              ? '<main>Requested product 42</main><script>setTimeout(()=>location.replace("https://www.amazon.com/Other/dp/B000000043"),100)</script>'
              : '<h4>Click the button below to continue shopping</h4><form method="get" action="/errors_page/validateCaptcha"><input type="hidden" name="amzn" value="opaque"><input type="hidden" name="amzn-r" value="opaque"><input type="hidden" name="field-keywords" value="server"><button type="submit">Continue shopping</button></form>',
          });
        return route.fulfill({
          contentType: 'text/html',
          body: '<main>Another product also mentioning Requested product 42</main>',
        });
      });
      await assert.rejects(
        scrapePage(
          page,
          target,
          {
            waitUntil: 'domcontentloaded',
            waitAfterLoad: 350,
            readinessTimeout: 500,
            workflow: 'auto',
          },
          new Deadline(8000),
        ),
        (e: any) => e.code === 'WORKFLOW_NAVIGATION_MISMATCH',
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  'coin overview recipe hydrates public content by scrolling it into view',
  { timeout: 15000 },
  async () => {
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'rebrowser',
        BROWSER_CHANNEL: 'chromium',
        BROWSER_HEADLESS: 'true',
      }),
    );
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<main style="height:5000px">Overview</main><section id="section-coin-about" data-test="section-about" style="height:400px"><p id="details" hidden>Coin overview details 42</p></section><script>new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))document.querySelector("#details").hidden=false}).observe(document.querySelector("#section-coin-about"))</script>',
        }),
      );
      await page.goto('https://coinmarketcap.com/currencies/bitcoin/', {
        waitUntil: 'domcontentloaded',
      });
      assert.equal(await page.locator('#details').isVisible(), false);
      const result = await applyWorkflow(page, 'auto', new Deadline(5000));
      await page
        .locator('#details')
        .waitFor({ state: 'visible', timeout: 1000 });
      assert.match(
        await page.locator('body').innerText(),
        /Coin overview details 42/,
      );
      assert.equal(result.steps[0]?.type, 'coin-about@1');
      assert.equal(result.steps[0]?.outcome, 'scrolled-into-view');
    } finally {
      await browser.close();
    }
  },
);

test(
  'Facebook application CDN loads while third-party ads remain blocked',
  { timeout: 15000 },
  async () => {
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'rebrowser',
        BROWSER_CHANNEL: 'chromium',
        BROWSER_HEADLESS: 'true',
      }),
    );
    try {
      const page = await browser.newPage();
      let ads = 0;
      let cdn = 0;
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (
          shouldBlockAdRequest(
            request.url(),
            page.url(),
            request.isNavigationRequest() &&
              request.frame().parentFrame() === null,
          )
        ) {
          ads++;
          return route.abort();
        }
        if (request.url() === 'https://www.facebook.com/NASA')
          return route.fulfill({
            contentType: 'text/html',
            body: '<main>Loading</main><script defer src="https://static.xx.fbcdn.net/rsrc.php/app.js"></script><script defer src="https://ad.doubleclick.net/ad.js"></script>',
          });
        if (request.url() === 'https://static.xx.fbcdn.net/rsrc.php/app.js') {
          cdn++;
          return route.fulfill({
            contentType: 'application/javascript',
            body: 'document.querySelector("main").textContent="NASA application ready";',
          });
        }
        return route.abort();
      });
      await page.goto('https://www.facebook.com/NASA', {
        waitUntil: 'domcontentloaded',
      });
      assert.equal(
        await page.locator('main').innerText(),
        'NASA application ready',
      );
      assert.equal(cdn, 1);
      assert.equal(ads, 1);
    } finally {
      await browser.close();
    }
  },
);

test(
  'late country controls navigate to the original product without a public request',
  { timeout: 15000 },
  async () => {
    const browser = await launchBrowser(
      browserConfiguration({
        BROWSER_ENGINE: 'rebrowser',
        BROWSER_CHANNEL: 'chromium',
        BROWSER_HEADLESS: 'true',
      }),
    );
    try {
      const page = await browser.newPage();
      let requests = 0;
      let phase = 'prompt';
      await page.route('**/*', async (route) => {
        if (!route.request().isNavigationRequest()) return route.abort();
        requests++;
        const url = new URL(route.request().url());
        const body =
          url.searchParams.get('intl') === 'nosplash'
            ? '<title>Product 42</title><main>Original product 42</main>'
            : phase === 'prompt'
              ? `<title>Country selector</title><main>Loading</main><script>setTimeout(()=>{document.body.innerHTML='<h1>Choose a country</h1><a href="?skuId=42&amp;intl=nosplash">United States</a>'},400)</script>`
              : `<title>Country selector</title><h1>Choose a country</h1><a id="country" href="/?intl=nosplash">United States</a><script>setTimeout(()=>{document.querySelector('#country').href='?skuId=42&intl=nosplash'},400)</script>`;
        await route.fulfill({ contentType: 'text/html', body });
      });
      for (const stage of ['prompt', 'destination']) {
        phase = stage;
        requests = 0;
        await page.goto('https://www.bestbuy.com/site/product/42.p?skuId=42', {
          waitUntil: 'domcontentloaded',
        });
        const result = await applyWorkflow(page, 'auto', new Deadline(5000));
        assert.equal(result.steps[0]?.outcome, 'navigated-original-product');
        assert.equal(new URL(page.url()).searchParams.get('skuId'), '42');
        assert.match(
          await page.locator('body').innerText(),
          /Original product 42/,
        );
        assert.equal(requests, 2);
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  'bounded workflows and retained tabs through the browser HTTP service',
  { timeout: 60000 },
  async (t) => {
    const fixture = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/shell-empty' || req.url === '/shell-loading')
        return res.end(
          `${req.url === '/shell-loading' ? '<main>Loading...</main>' : ''}<script>setTimeout(()=>document.body.innerHTML='<main>Late rendered product 42</main>',350)</script>`,
        );
      if (req.url === '/empty-stays')
        return res.end('<title>Only metadata</title><main></main>');
      if (req.url === '/hello') return res.end('<main>Hello</main>');
      if (req.url === '/transient-gate')
        return res.end(
          '<main id="sec-if-cpt-container" style="display:none"><div id="sec-bc-tile-container"></div><button id="progress-button" disabled></button><img class="scf-akamai-logo"></main><script>setTimeout(()=>document.body.innerHTML="<main>Late rendered product 42</main>",350)</script>',
        );
      if (req.url === '/akamai-empty')
        return res.end(
          '<main id="sec-if-cpt-container" style="display:none"><div id="sec-bc-tile-container"></div><button id="progress-button" disabled></button><img class="scf-akamai-logo"></main>',
        );
      if (req.url?.startsWith('/static-denial')) {
        res.statusCode = 403;
        if (req.url.endsWith('-chunked')) {
          res.write('<title>Access denied</title><main>Access denied</main>');
          return res.end();
        }
        return res.end(
          '<title>Access denied</title><main>Access denied</main>',
        );
      }
      if (req.url === '/active-error') {
        res.statusCode = 403;
        return res.end(
          '<main>Loading</main><script>setTimeout(()=>location.href="/ready",400)</script>',
        );
      }
      if (req.url === '/ready') return res.end('<main>Ready product 42</main>');
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
        'automatic workflows wait for rendered shells without a marker hint and keep empty/verification states explicit',
        async () => {
          for (const path of [
            '/shell-empty',
            '/shell-loading',
            '/transient-gate',
          ]) {
            const result = await scrape(service.baseUrl, origin + path, {
              workflow: 'auto',
              wait_until: 'domcontentloaded',
              wait_after_load: 0,
              readiness_timeout: 2000,
            });
            assert.equal(result.body.readiness.requested, false);
            assert.equal(result.body.readiness.satisfied, true);
            assert.equal(result.body.readiness.automatic.outcome, 'ready');
            assert.match(result.body.renderedText, /Late rendered product 42/);
          }
          const empty = await scrape(service.baseUrl, origin + '/empty-stays', {
            workflow: 'auto',
            readiness_timeout: 120,
          });
          assert.equal(empty.body.interaction.state, 'CONTENT_NOT_READY');
          assert.equal(empty.body.errorCode, 'CONTENT_NOT_READY');
          const verification = await scrape(
            service.baseUrl,
            origin + '/akamai-empty',
            { workflow: 'auto', readiness_timeout: 120 },
          );
          assert.equal(verification.body.botDetection.provider, 'akamai');
          assert.equal(
            verification.body.interaction.state,
            'VERIFICATION_REQUIRED',
          );
          assert.equal(verification.body.readiness.satisfied, false);
          const hello = await scrape(service.baseUrl, origin + '/hello', {
            workflow: 'auto',
          });
          assert.equal(hello.body.readiness.satisfied, true);
          assert.equal(hello.body.readiness.automatic.outcome, 'ready');
        },
      );
      await t.test(
        'static HTTP denials skip futile readiness while active error redirects can finish',
        async () => {
          for (const path of ['/static-denial', '/static-denial-chunked']) {
            const denied = await scrape(service.baseUrl, `${origin}${path}`, {
              wait_for_text: 'Ready product 42',
              wait_until: 'domcontentloaded',
              wait_after_load: 0,
              readiness_timeout: 3000,
            });
            assert.equal(denied.body.pageStatusCode, 403);
            assert.equal(denied.body.readiness.satisfied, false);
            assert.equal(
              denied.body.diagnostics.readinessWaitSkipped,
              'static_http_error',
            );
          }
          const active = await scrape(
            service.baseUrl,
            `${origin}/active-error`,
            {
              wait_for_text: 'Ready product 42',
              wait_until: 'domcontentloaded',
              wait_after_load: 0,
              readiness_timeout: 3000,
            },
          );
          assert.equal(active.body.pageStatusCode, 200);
          assert.equal(active.body.readiness.satisfied, true);
          assert.equal(active.body.diagnostics.readinessWaitSkipped, undefined);
        },
      );
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
