import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserConfiguration } from './browser';

test('defaults to Rebrowser and full Chromium with no fingerprint injection', () => {
  const config = browserConfiguration({});
  assert.equal(config.engine, 'rebrowser');
  assert.equal(config.launchOptions.channel, 'chromium');
  assert.equal(config.launchOptions.headless, true);
  assert.ok(
    config.launchOptions.args.includes('--proxy-bypass-list=<-loopback>'),
  );
  assert.ok(!config.launchOptions.args.includes('--disable-gpu'));
});

test('supports an explicit Playwright fallback and headful Chrome', () => {
  const config = browserConfiguration({
    BROWSER_ENGINE: 'playwright',
    BROWSER_HEADLESS: 'false',
    BROWSER_CHANNEL: 'chrome',
  });
  assert.equal(config.engine, 'playwright');
  assert.equal(config.launchOptions.headless, false);
  assert.equal(config.launchOptions.channel, 'chrome');
});

test('invalid engine and headless configuration fail instead of silently downgrading', () => {
  assert.throws(
    () => browserConfiguration({ BROWSER_ENGINE: 'unknown' }),
    /BROWSER_ENGINE/,
  );
  assert.throws(
    () => browserConfiguration({ BROWSER_HEADLESS: 'nope' }),
    /BROWSER_HEADLESS/,
  );
});

test('Camoufox is an explicit Firefox choice without Chromium launch flags', () => {
  const config = browserConfiguration({
    BROWSER_ENGINE: 'camoufox',
    BROWSER_HEADLESS: 'false',
  });
  assert.equal(config.engine, 'camoufox');
  assert.equal(config.launchOptions.headless, false);
  assert.equal(config.launchOptions.channel, undefined);
  assert.deepEqual(config.launchOptions.args, []);
  assert.throws(
    () =>
      browserConfiguration({
        BROWSER_ENGINE: 'camoufox',
        BROWSER_CHANNEL: 'chrome',
      }),
    /BROWSER_CHANNEL/,
  );
});
