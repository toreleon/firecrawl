import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkTiming } from './benchmark-timing';

test('an uninterrupted run tolerates normal timer jitter', () => {
  let now = 0;
  const timing = new BenchmarkTiming(() => now);
  for (const tick of [1000, 2100, 3050, 4050]) {
    now = tick;
    assert.equal(timing.sample(), false);
  }
  assert.equal(timing.snapshot().valid, true);
  assert.equal(timing.snapshot().maximumObservedGapMs, 1100);
});

test('host suspension invalidates timing without discarding the gap after recovery', () => {
  let now = 0;
  const timing = new BenchmarkTiming(() => now);
  now = 1000;
  timing.sample();
  now = 181000;
  assert.equal(timing.sample(), true);
  now = 182000;
  timing.sample();
  const result = timing.snapshot();
  assert.equal(result.valid, false);
  assert.equal(result.maximumObservedGapMs, 180000);
  assert.deepEqual(result.gaps, [{
    from: new Date(1000).toISOString(),
    to: new Date(181000).toISOString(),
    elapsedMs: 180000,
  }]);
});

test('a backwards wall-clock adjustment also invalidates latency measurements', () => {
  let now = 5000;
  const timing = new BenchmarkTiming(() => now);
  now = 4000;
  const result = timing.snapshot();
  assert.equal(result.valid, false);
  assert.equal(result.gaps[0].elapsedMs, -1000);
});
