import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiOutputMetrics,
  apiRequestBody,
  normalizeApiResponse,
  redact,
  validateProfiles,
  ProfilePacer,
} from './api-benchmark';
import { scoreObservation } from './waf-benchmark';

const target = {
  name: 'fixture',
  url: 'https://fixture.test',
  containsText: 'Expected company',
};
test('API normalization requires target HTTP status and raw HTML, even when API success is true', () => {
  assert.equal(
    scoreObservation(
      target,
      normalizeApiResponse(500, { success: false, code: 'NETWORK_ERROR' }),
    ).failureReason,
    'network_error',
  );
  for (const data of [
    { rawHtml: '<main>Expected company</main>' },
    { markdown: 'Expected company', metadata: { statusCode: 200 } },
    { rawHtml: 'Expected company', metadata: { statusCode: '200' } },
  ])
    assert.equal(
      scoreObservation(
        target,
        normalizeApiResponse(200, { success: true, data }),
      ).normalizedPass,
      false,
    );
  const data = {
    rawHtml: '<main>Expected company</main>',
    metadata: { statusCode: 200 },
  };
  assert.equal(
    scoreObservation(target, normalizeApiResponse(200, { success: true, data }))
      .normalizedPass,
    true,
  );
  assert.equal(
    scoreObservation(
      target,
      normalizeApiResponse(200, { success: false, data }),
    ).normalizedPass,
    false,
  );
  assert.equal(
    scoreObservation(
      target,
      normalizeApiResponse(200, {
        success: true,
        data: { ...data, metadata: { statusCode: 200, error: 'Failure' } },
      }),
    ).normalizedPass,
    false,
  );
});

test('profile configuration keeps keys in named environment variables and forbids credential redirects', () => {
  const profiles = [
    { name: 'fork', baseUrl: 'http://127.0.0.1:3002' },
    {
      name: 'hosted',
      baseUrl: 'https://api.firecrawl.dev',
      apiKeyEnv: 'HOSTED_FIRECRAWL_API_KEY',
    },
  ];
  assert.equal(validateProfiles(profiles).length, 2);
  for (const broken of [
    [],
    [profiles[0]],
    [profiles[0], profiles[0]],
    [profiles[0], { ...profiles[1], apiKey: 'literal-secret' }],
    [
      profiles[0],
      { ...profiles[1], baseUrl: 'https://user:password@fixture.test' },
    ],
    [
      profiles[0],
      { ...profiles[1], baseUrl: 'https://fixture.test?key=secret' },
    ],
    [profiles[0], { ...profiles[1], baseUrl: 'http://fixture.test' }],
  ])
    assert.throws(() => validateProfiles(broken));
});

test('fresh request options are fixed and Markdown checks never replace HTML grading', () => {
  const body = apiRequestBody(
    {
      name: 'fork',
      baseUrl: 'https://fixture.test',
      browserControls: { workflow: 'auto' },
    },
    target.url,
    90000,
  );
  assert.deepEqual(body, {
    url: target.url,
    formats: ['rawHtml', 'markdown'],
    onlyMainContent: false,
    maxAge: 0,
    storeInCache: false,
    waitFor: 0,
    timeout: 85000,
    browserControls: { workflow: 'auto' },
  });
  assert.equal(JSON.stringify(body).includes(target.containsText), false);
  const metrics = apiOutputMetrics(
    {
      success: true,
      data: {
        markdown: 'Expected company',
        metadata: { creditsUsed: 5, cacheState: 'miss' },
      },
    },
    target.containsText,
  );
  assert.equal(metrics.markdownMarkerPresent, true);
  assert.equal(metrics.creditsUsed, 5);
  assert.equal(metrics.rawHtmlReturned, false);
  assert.equal(apiOutputMetrics({}, target.containsText).creditsUsed, null);
  assert.equal(
    apiOutputMetrics(
      { data: { metadata: { creditsUsed: -1 } } },
      target.containsText,
    ).creditsUsed,
    null,
  );
});

test('secrets are removed recursively from response content and error strings', () => {
  const saved = redact(
    {
      token: 'test-secret',
      nested: ['Bearer test-secret', { html: '<main>test-secret</main>' }],
    },
    ['test-secret'],
  );
  assert.equal(saved.includes('test-secret'), false);
  assert.equal(JSON.parse(saved).nested[0], 'Bearer [REDACTED]');
});

test('all workers share a profile dispatch interval while other profiles remain independent', async () => {
  const pacer = new ProfilePacer();
  const starts: number[] = [];
  const profile = {
    name: 'paced',
    baseUrl: 'https://fixture.test',
    minIntervalMs: 25,
  };
  const waiting = Array.from({ length: 5 }, async () => {
    await pacer.wait(profile);
    starts.push(Date.now());
  });
  await pacer.wait({ name: 'other', baseUrl: 'https://fixture.test' });
  assert.ok(
    starts.length < 5,
    'another profile must not wait for the paced queue',
  );
  await Promise.all(waiting);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 24);
  assert.throws(() =>
    validateProfiles([
      { ...profile, minIntervalMs: -1 },
      { name: 'other', baseUrl: 'https://fixture.test' },
    ]),
  );
});
