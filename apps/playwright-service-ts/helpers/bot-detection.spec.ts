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
  ])
    assert.equal(detectBotChallenge(html), undefined);
});
