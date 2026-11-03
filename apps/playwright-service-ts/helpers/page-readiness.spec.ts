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
  for (const text of ['Hello', 'Loading instructions for this product', '42'])
    assert.equal(renderedBodyState(text), 'ready');
});
