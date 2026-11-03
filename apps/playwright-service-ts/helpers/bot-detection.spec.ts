import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBotChallenge } from './bot-detection';

test('recognizes a Cloudflare challenge header independently of its HTTP status', () => {
  assert.equal(
    detectBotChallenge('checking', { 'CF-Mitigated': 'challenge' })?.provider,
    'cloudflare',
  );
});

test('recognizes a challenge interstitial and a human verification page', () => {
  assert.equal(
    detectBotChallenge(
      '<title>Just a moment...</title><div id="cf-chl-widget"></div>',
    )?.provider,
    'cloudflare',
  );
  assert.equal(
    detectBotChallenge(
      '<title>Verify you are human</title><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>',
    )?.provider,
    'captcha',
  );
});

test('ordinary pages with CAPTCHA forms or Cloudflare assets are not challenges', () => {
  for (const html of [
    '<title>Contact company</title><div class="cf-turnstile"></div>',
    '<title>Support</title><div class="g-recaptcha"></div>',
    '<title>Documentation</title><script src="/cdn-cgi/challenge-platform/example.js"></script>',
    '<title>Just a moment...</title><main>Ordinary article</main>',
    '<title>Product</title><main>Product description</main><script src="https://js.datadome.co/tags.js"></script>',
    '<title>Contact</title><div id="px-captcha"></div><main>Contact our team</main>',
    '<title>Documentation</title><pre>geo.captcha-delivery.com</pre>',
  ])
    assert.equal(detectBotChallenge(html), undefined);
});

test('recognizes domain-titled DataDome bootstrap documents without confusing ordinary tags', () => {
  for (const rt of ['c', 'i']) {
    assert.equal(
      detectBotChallenge(
        `<title>news.example</title><script>var dd={'rt':'${rt}','cid':'fixture','hsh':'fixture','host':'geo.captcha-delivery.com'}</script><script src="https://ct.captcha-delivery.com/i.js"></script>`,
      )?.provider,
      'datadome',
    );
  }
});

test('recognizes the observed Reddit and HUMAN interstitial layouts', () => {
  assert.equal(
    detectBotChallenge(
      '<title>Reddit - Prove your humanity</title><main>Complete the challenge below</main><iframe src="/captcha"></iframe>',
    )?.provider,
    'reddit',
  );
  assert.equal(
    detectBotChallenge(
      '<title>Skyscanner</title><div id="px-captcha"></div><main>Are you a person or a robot?</main>',
    )?.provider,
    'perimeterx',
  );
});
