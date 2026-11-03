import {
  chromium as playwrightChromium,
  Browser,
  LaunchOptions,
} from 'playwright';
import { chromium as patchrightChromium } from 'patchright';
import { chromium as rebrowserChromium } from 'rebrowser-playwright';

export type BrowserEngine =
  | 'patchright'
  | 'rebrowser'
  | 'playwright'
  | 'camoufox';
export const CAMOUFOX_BROWSER_BUILD = 'official/158.0.1-beta.41';

export const browserConfiguration = (env: NodeJS.ProcessEnv = process.env) => {
  const engine = env.BROWSER_ENGINE ?? 'rebrowser';
  if (
    engine !== 'patchright' &&
    engine !== 'playwright' &&
    engine !== 'rebrowser' &&
    engine !== 'camoufox'
  ) {
    throw new Error(
      'BROWSER_ENGINE must be patchright, rebrowser, playwright or camoufox',
    );
  }
  const headless = env.BROWSER_HEADLESS ?? 'true';
  if (headless !== 'true' && headless !== 'false') {
    throw new Error('BROWSER_HEADLESS must be true or false');
  }
  if (engine === 'camoufox' && env.BROWSER_CHANNEL)
    throw new Error(
      'BROWSER_CHANNEL is a Chromium option and cannot be used with Camoufox',
    );
  return {
    engine: engine as BrowserEngine,
    launchOptions: {
      // Use full Chromium's new headless mode rather than chrome-headless-shell.
      channel:
        engine === 'camoufox' ? undefined : env.BROWSER_CHANNEL || 'chromium',
      headless: headless === 'true',
      args:
        engine === 'camoufox'
          ? []
          : [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--window-size=1365,900',
              // Keep loopback requests behind the existing SSRF-checking proxy too.
              '--proxy-bypass-list=<-loopback>',
              '--webrtc-ip-handling-policy=disable_non_proxied_udp',
            ],
    } satisfies LaunchOptions,
  };
};

export const launchBrowser = async (
  configuration = browserConfiguration(),
): Promise<Browser> => {
  if (configuration.engine === 'camoufox') {
    const { Camoufox, findInstalledVersion } = await import('camoufox');
    if (!findInstalledVersion(CAMOUFOX_BROWSER_BUILD))
      throw new Error(
        'Pinned Camoufox browser is not installed; run pnpm prepare:camoufox before starting this owner',
      );
    return (await Camoufox({
      browser: CAMOUFOX_BROWSER_BUILD,
      os:
        process.platform === 'darwin'
          ? 'macos'
          : process.platform === 'win32'
            ? 'windows'
            : 'linux',
      headless: configuration.launchOptions.headless,
      window: [1365, 900],
      geoip: false,
      block_webrtc: true,
      humanize: false,
      exclude_addons: ['UBO'],
      firefox_user_prefs: {
        // Firefox must send localhost and DNS traffic through the same pinned
        // filtering proxy as Chromium; no alternate DNS or WebRTC egress.
        'network.proxy.allow_hijacking_localhost': true,
        'network.proxy.no_proxies_on': '',
        'network.trr.mode': 5,
        'media.peerconnection.enabled': false,
      },
    })) as unknown as Browser;
  }
  const chromium =
    configuration.engine === 'patchright'
      ? patchrightChromium
      : configuration.engine === 'rebrowser'
        ? rebrowserChromium
        : playwrightChromium;
  const browser = await chromium.launch(configuration.launchOptions);
  // Patched drivers extend evaluate/selector generics, so their declarations are not
  // structurally assignable to Playwright's. Normalize only at this driver
  // boundary; both implementations exercise the same HTTP integration suite.
  return browser as unknown as Browser;
};
