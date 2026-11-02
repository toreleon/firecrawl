import {
  chromium as playwrightChromium,
  Browser,
  LaunchOptions,
} from 'playwright';
import { chromium as patchrightChromium } from 'patchright';
import { chromium as rebrowserChromium } from 'rebrowser-playwright';

export type BrowserEngine = 'patchright' | 'rebrowser' | 'playwright';

export const browserConfiguration = (env: NodeJS.ProcessEnv = process.env) => {
  const engine = env.BROWSER_ENGINE ?? 'rebrowser';
  if (
    engine !== 'patchright' &&
    engine !== 'playwright' &&
    engine !== 'rebrowser'
  ) {
    throw new Error(
      'BROWSER_ENGINE must be patchright, rebrowser or playwright',
    );
  }
  const headless = env.BROWSER_HEADLESS ?? 'true';
  if (headless !== 'true' && headless !== 'false') {
    throw new Error('BROWSER_HEADLESS must be true or false');
  }
  return {
    engine: engine as BrowserEngine,
    launchOptions: {
      // Use full Chromium's new headless mode rather than chrome-headless-shell.
      channel: env.BROWSER_CHANNEL || 'chromium',
      headless: headless === 'true',
      args: [
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
