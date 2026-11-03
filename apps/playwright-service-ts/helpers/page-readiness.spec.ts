import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPageProtection, renderedBodyState } from './page-readiness';

const amazon =
  '<form action="/errors_page/validateCaptcha"><h4>Click the button below to continue shopping</h4><button>Continue shopping</button></form>';
const akamai =
  '<main id="sec-if-cpt-container" style="display:none"><div id="sec-bc-tile-container"></div><button id="progress-button" disabled></button><img class="scf-akamai-logo"></main>';
const google =
  '<form id="captcha-form" action="index" method="post"><div class="g-recaptcha"></div></form><p>Our systems have detected unusual traffic from your computer network.</p>';

test('runtime recognizes observed Amazon and hidden Akamai verification shells', () => {
  assert.equal(detectPageProtection(amazon)?.provider, 'amazon');
  assert.equal(detectPageProtection(akamai)?.provider, 'akamai');
});
test('runtime recognizes the observed unusual-traffic form without treating an ordinary CAPTCHA widget as a gate', () => {
  assert.equal(detectPageProtection(google)?.provider, 'google');
  for (const html of [
    '<form id="captcha-form"><div class="g-recaptcha"></div><button>Contact us</button></form>',
    '<article>Our systems have detected unusual traffic from your computer network.</article>',
    `<main>Documentation</main><script>const example=${JSON.stringify(google)}</script>`,
    `<main>Documentation</main><!--${google}-->`,
  ])
    assert.equal(detectPageProtection(html), undefined);
});
test('runtime classification does not mistake code samples, comments or ordinary vendor assets for an interstitial', () => {
  for (const html of [
    `<main>Normal product</main><script>const sample=${JSON.stringify(akamai)}</script>`,
    `<main>Normal product</main><!--${amazon}-->`,
    '<main>Normal product</main><script src="https://akamai.com/analytics.js"></script>',
    '<main>Continue shopping</main><form action="/cart"><button>Continue shopping</button></form>',
  ])
    assert.equal(detectPageProtection(html), undefined);
});
test('automatic body readiness distinguishes empty/loading shells from short real content', () => {
  assert.equal(renderedBodyState(' \n '), 'empty');
  for (const text of ['Loading...', 'loading…', 'Please wait.'])
    assert.equal(renderedBodyState(text), 'loading');
  for (const text of [
    'Hello',
    'Loading instructions for this product',
    '42',
  ])
    assert.equal(renderedBodyState(text), 'ready');
});

test('format-only bodies are empty and cannot end automatic hydration waits', () => {
  assert.equal(
    renderedBodyState('\u200b\u200c\u200d\u2060\ufeff'),
    'empty',
  );
  assert.equal(renderedBodyState('Loading\u200b...'), 'loading');
  assert.equal(renderedBodyState('Product\u200b 42'), 'ready');
  assert.equal(renderedBodyState('👩‍💻'), 'ready');
});

test('AWS action headers distinguish passive challenge from interactive CAPTCHA', () => {
  const captcha = detectPageProtection('', {
    'X-Amzn-Waf-Action': 'captcha',
  });
  assert.equal(captcha?.provider, 'aws-waf');
  assert.equal((captcha as any)?.interactive, true);
  const passive = detectPageProtection('', {
    'x-amzn-waf-action': 'challenge',
  });
  assert.equal(passive?.provider, 'aws-waf');
  assert.notEqual((passive as any)?.interactive, true);
});

test('observed AWS CAPTCHA shells require live scripts and interstitial structure', () => {
  const classic =
    '<title>Human Verification</title><script src="https://abc.def.us-east-1.captcha.awswaf.com/a/b/c/captcha.js"></script><div id="captcha-container"></div>';
  const custom =
    '<title>Shop Captcha</title><script src="https://abc.eu-central-1.captcha-sdk.awswaf.com/abc/jsapi.js"></script><script src="https://abc.def.eu-central-1.token.awswaf.com/abc/challenge.js"></script><body>Unusual traffic.</body>';
  for (const html of [classic, custom]) {
    const d = detectPageProtection(html);
    assert.equal(d?.provider, 'aws-waf');
    assert.equal((d as any)?.interactive, true);
  }
  for (const html of [
    '<title>Contact us</title><main>Send a message</main><script src="https://abc.eu-central-1.captcha-sdk.awswaf.com/abc/jsapi.js"></script><div id="captcha-container"></div>',
    `<title>Documentation</title><main>API example</main><script>const sample=${JSON.stringify(classic)}</script>`,
    `<!--${classic}--><main>Normal product</main>`,
    classic.replace(
      'captcha.awswaf.com',
      'captcha.awswaf.com.attacker.test',
    ),
  ])
    assert.equal(detectPageProtection(html), undefined);
});

test('passive AWS connection shells require the observed scripts and waiting structure', () => {
  const shell =
    '<title>Verifying Connection</title><script src="https://abc.edge.sdk.awswaf.com/abc/def/challenge.js" defer></script><div id="loading-state"><p id="status-text">Please wait while we verify your browser.</p></div><script src="/interstitial/interstitial.js" defer></script>';
  assert.deepEqual(detectPageProtection(shell), {
    provider: 'aws-waf',
    reason: 'Passive AWS WAF connection verification interstitial',
    passive: true,
  });
  assert.equal(
    detectPageProtection(shell.replace(
      'Please wait while we verify your browser.',
      'Verified! Redirecting...',
    ))?.passive,
    true,
  );
  assert.equal(
    detectPageProtection(shell, { 'x-amzn-waf-action': 'captcha' })
      ?.interactive,
    true,
  );
  assert.notEqual(
    detectPageProtection(shell, { 'x-amzn-waf-action': 'captcha' })?.passive,
    true,
  );
  for (const html of [
    shell.replace('Verifying Connection', 'Ordinary public record'),
    shell.replace('id="loading-state"', 'id="content"'),
    shell.replace('id="status-text"', 'id="description"'),
    shell.replace('/interstitial/interstitial.js', '/application.js'),
    shell.replace('Please wait while we verify your browser.', 'Public record'),
    shell.replace(
      'https://abc.edge.sdk.awswaf.com/',
      'http://abc.edge.sdk.awswaf.com/',
    ),
    shell.replace('sdk.awswaf.com/', 'sdk.awswaf.com.attacker.test/'),
    `<main>Documentation</main><script>const sample=${JSON.stringify(shell)}</script>`,
    `<main>Documentation</main><!--${shell}-->`,
  ])
    assert.equal(detectPageProtection(html), undefined);
});

test('an empty HUMAN shell on a CAPTCHA route is verification, not UUID content', () => {
  const shell =
    '<title>Travel</title><div id="app_main"><div id="px-captcha"></div><p>c4edbd88-d790-11f1-acc3-9f65e4b607cd</p></div>';
  const d = (detectPageProtection as any)(
    shell,
    {},
    'https://travel.test/sttc/px/captcha-v2/index.html?url=original',
  );
  assert.equal(d?.provider, 'perimeterx');
  assert.equal(d?.interactive, true);
  assert.equal(
    (detectPageProtection as any)(shell, {}, 'https://travel.test/contact'),
    undefined,
  );
  assert.equal(
    (detectPageProtection as any)(
      `<!--${shell}--><main>Normal</main>`,
      {},
      'https://travel.test/sttc/px/captcha-v2/index.html',
    ),
    undefined,
  );
});

test('a known HUMAN press-and-hold interstitial is interactive even after its text loads', () => {
  const html = '<div id="px-captcha">Press &amp; Hold to confirm</div>';
  assert.equal(detectPageProtection(html)?.provider, 'perimeterx');
  assert.equal(detectPageProtection(html)?.interactive, true);
});

test('the observed eBay passive shell needs its continuation form, script and text', () => {
  const shell =
    '<title>Pardon Our Interruption...</title><p>Checking your browser before you access eBay.</p><form id="destForm" method="GET" action="https://www.ebay.com/itm/42"></form><script src="https://ir.ebaystatic.com/rs/c/challenge-abc.js"></script>';
  assert.equal(detectPageProtection(shell)?.provider, 'ebay');
  assert.notEqual((detectPageProtection(shell) as any)?.interactive, true);
  for (const html of [
    shell.replace('id="destForm"', 'id="contact"'),
    shell.replace('ir.ebaystatic.com', 'ir.ebaystatic.com.attacker.test'),
    `<main>Normal product</main><script>const sample=${JSON.stringify(shell)}</script>`,
    `<!--${shell}--><main>Normal product</main>`,
  ])
    assert.equal(detectPageProtection(html), undefined);
});
