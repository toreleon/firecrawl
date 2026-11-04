import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserConfiguration, launchBrowser } from './browser';
import { webkitChildEnvironment } from './webkit';

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

test('WebKit needs an explicit filtered port and rejects Chromium options', async () => {
  const config = browserConfiguration({ BROWSER_ENGINE: 'webkit' });
  assert.equal(config.engine, 'webkit');
  assert.equal(config.filterPort, 3004);
  assert.equal(config.launchOptions.channel, undefined);
  assert.deepEqual(config.launchOptions.args, []);
  assert.throws(
    () =>
      browserConfiguration({
        BROWSER_ENGINE: 'webkit',
        BROWSER_CHANNEL: 'chromium',
      }),
    /BROWSER_CHANNEL/,
  );
  for (const port of ['0', '80', '03004', '65536', '3004;echo', 'not-a-port'])
    assert.throws(
      () =>
        browserConfiguration({
          BROWSER_ENGINE: 'webkit',
          BROWSER_FILTER_PORT: port,
        }),
      /BROWSER_FILTER_PORT/,
    );
  await assert.rejects(launchBrowser(config), /listening SSRF filter/);
  await assert.rejects(
    launchBrowser(config, { ssrfProxyPort: 3005 }),
    /listening SSRF filter/,
  );
});

test('WebKit child environment excludes service and loader credentials', () => {
  const environment = webkitChildEnvironment('/trusted/webkit/pw_run.sh', {
    DISPLAY: ':12',
    LANG: 'en_US.UTF-8',
    TZ: 'UTC',
    BROWSER_SERVICE_AUTH_TOKEN: 'private-service-token',
    PROXY_PASSWORD: 'private-proxy-password',
    DATABASE_URL: 'private-database-url',
    NODE_OPTIONS: '--require=/untrusted/bootstrap.js',
    LD_PRELOAD: '/untrusted/loader.so',
    PATH: '/untrusted/bin',
    FIRECRAWL_WEBKIT_EXECUTABLE: '/untrusted/browser',
  });
  assert.deepEqual(environment, {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    FIRECRAWL_WEBKIT_EXECUTABLE: '/trusted/webkit/pw_run.sh',
    DISPLAY: ':12',
    LANG: 'en_US.UTF-8',
    TZ: 'UTC',
  });
});
