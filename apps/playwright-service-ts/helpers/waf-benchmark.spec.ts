import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreObservation,
  summarizeAttempts,
  textContent,
  WafAttempt,
} from './waf-benchmark';

const target = {
  name: 'fixture',
  url: 'https://fixture.test/',
  containsText: 'Example company',
};
const observation = (content: string, pageStatusCode = 200) => ({
  apiStatus: 200,
  body: { content, pageStatusCode },
});

test('a genuine page passes both compatible and screened scoring', () => {
  const score = scoreObservation(
    target,
    observation('<main>Example company</main>'),
  );
  assert.equal(score.frontierPass, true);
  assert.equal(score.screenedPass, true);
  assert.equal(score.failureReason, undefined);
});

test('HTTP 200 challenge content is not counted as screened success even if it echoes the marker', () => {
  const score = scoreObservation(
    target,
    observation(
      '<title>Just a moment...</title><div id="cf-chl-widget">Example company</div>',
    ),
  );
  assert.equal(score.frontierPass, true);
  assert.equal(score.screenedPass, false);
  assert.equal(score.failureReason, 'challenge');
});

test('an empty shell with a marker only in its script passes the legacy rule but fails content screening', () => {
  const score = scoreObservation(
    target,
    observation(
      '<script>const product="Example company"</script><body>Loading</body>',
    ),
  );
  assert.equal(score.frontierPass, true);
  assert.equal(score.textMarkerPresent, false);
  assert.equal(score.failureReason, 'marker_only_in_noncontent_markup');
});

test('a missing expected marker is a failure and a contact CAPTCHA widget alone is not', () => {
  assert.equal(
    scoreObservation(target, observation('<main>Other company</main>'))
      .failureReason,
    'missing_expected_marker',
  );
  assert.equal(
    scoreObservation(
      target,
      observation(
        '<main>Example company</main><div class="cf-turnstile"></div>',
      ),
    ).screenedPass,
    true,
  );
});

test('target failures and service failures retain distinct classifications', () => {
  for (const [status, reason] of [
    [403, 'target_status_403'],
    [429, 'rate_limited'],
    [404, 'target_unavailable'],
    [410, 'target_unavailable'],
  ] as const) {
    const score = scoreObservation(
      target,
      observation('Example company', status),
    );
    assert.equal(score.frontierPass, false);
    assert.equal(score.failureReason, reason);
  }
  assert.equal(
    scoreObservation(target, {
      apiStatus: 500,
      body: { error: 'Browser failed' },
    }).failureReason,
    'service_error',
  );
  assert.equal(
    scoreObservation(target, {
      apiStatus: 200,
      body: { content: 'Example company' },
    }).failureReason,
    'target_status_missing',
  );
});

test('timeouts are not reclassified as vendor WAF blocks', () => {
  const score = scoreObservation(target, {
    apiStatus: 0,
    body: {},
    transportError: 'AbortError',
    timedOut: true,
  });
  assert.equal(score.frontierPass, false);
  assert.equal(score.failureReason, 'timeout');
  assert.equal(
    scoreObservation(target, {
      apiStatus: 0,
      body: {},
      transportError: 'ECONNRESET',
    }).failureReason,
    'transport_error',
  );
});

test('text screening removes non-content markup without executing it', () => {
  assert.equal(
    textContent(
      '<style>bad</style><noscript>bad</noscript><!--bad--><p>A &amp; B</p>',
    ),
    'A & B',
  );
});

test('summary retains failures in the denominator and keeps timeout latency out of successful latency', () => {
  const make = (
    content: string,
    latencyMs: number,
    wafLabel = 'cloudflare',
  ): WafAttempt => ({
    target: 'fixture',
    url: target.url,
    wafLabel,
    attempt: 1,
    startedAt: new Date(0).toISOString(),
    latencyMs,
    ...scoreObservation(target, observation(content)),
  });
  const good = make('Example company', 50);
  const challenge = make(
    '<title>Just a moment...</title><div id="cf-chl-widget">Example company</div>',
    10,
  );
  const timeout: WafAttempt = {
    ...make('', 90000, 'datadome'),
    ...scoreObservation(target, {
      apiStatus: 0,
      body: {},
      transportError: 'AbortError',
      timedOut: true,
    }),
  };
  const summary = summarizeAttempts([good, challenge, timeout]);
  assert.equal(summary.overall.requests, 3);
  assert.equal(summary.overall.frontierPasses, 2);
  assert.equal(summary.overall.screenedPasses, 1);
  assert.equal(summary.overall.screenedSuccessRate, 1 / 3);
  assert.equal(summary.overall.successfulLatencyP95Ms, 50);
  assert.equal(summary.overall.allAttemptLatencyP95Ms, 90000);
  assert.equal(summary.byWafLabel.datadome.screenedSuccessRate, 0);
  assert.equal(summarizeAttempts([]).overall.screenedSuccessRate, null);
});
