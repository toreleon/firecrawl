import type { Page, Frame } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Deadline, ScrapeFailure } from './scrape-control';

export type ConsentPolicy = 'off' | 'rejectNonEssential' | 'acceptAll';
export type Workflow = 'none' | 'auto' | 'bestbuy-us@1' | 'product-details@1';
export type BrowserAction =
  | { type: 'click'; selector: string; all?: boolean }
  | { type: 'wait'; milliseconds?: number; selector?: string }
  | { type: 'write'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction?: 'up' | 'down'; selector?: string }
  | { type: 'scrape' };
export const actionTypes = [
  'click',
  'wait',
  'write',
  'press',
  'scroll',
  'scrape',
];
export const handoffKeys = [
  'Tab',
  'Shift+Tab',
  'Enter',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];
export const workflowIds = [
  'none',
  'auto',
  'bestbuy-us@1',
  'product-details@1',
];
export const validActions = (value: unknown): value is BrowserAction[] =>
  Array.isArray(value) &&
  value.length <= 30 &&
  value.every((a) => {
    if (!a || typeof a !== 'object' || !actionTypes.includes(a.type))
      return false;
    const text = (s: unknown, max = 2048) =>
      typeof s === 'string' && !!s.trim() && s.length <= max;
    if (a.type === 'click') return text(a.selector) && !a.all;
    if (a.type === 'wait')
      return (
        (text(a.selector) && a.milliseconds === undefined) ||
        (a.selector === undefined &&
          Number.isInteger(a.milliseconds) &&
          a.milliseconds > 0 &&
          a.milliseconds <= 60000)
      );
    if (a.type === 'write') return text(a.text, 10000);
    if (a.type === 'press') return text(a.key, 100);
    if (a.type === 'scroll')
      return (
        (a.direction === undefined || ['up', 'down'].includes(a.direction)) &&
        (a.selector === undefined || text(a.selector))
      );
    return true;
  });

type ConsentResult = {
  policy: ConsentPolicy;
  outcome: 'off' | 'not_detected' | 'applied' | 'unresolved';
  cmp?: string;
  selfTest?: boolean;
  version: string;
};
type ConsentBridge = {
  policy: ConsentPolicy;
  result: ConsentResult;
  stop: () => void;
};
const bridges = new WeakMap<Page, ConsentBridge>();
let consentAssets: { script: string; rules: unknown } | undefined;
const assets = () =>
  (consentAssets ??= {
    script: readFileSync(
      path.join(
        path.dirname(require.resolve('@duckduckgo/autoconsent')),
        'autoconsent.playwright.js',
      ),
      'utf8',
    ),
    rules: JSON.parse(
      readFileSync(
        require.resolve('@duckduckgo/autoconsent/rules/rules.json'),
        'utf8',
      ),
    ),
  });

// Bound to a Page and the source Frame. No page-supplied JavaScript is executed
// by the Node bridge. Eval-based CMP rules are reported unresolved instead.
export const prepareConsent = async (
  page: Page,
  policy: ConsentPolicy,
  automatic = true,
) => {
  const prior = bridges.get(page);
  if (prior) {
    if (prior.policy !== policy)
      throw new ScrapeFailure(
        'SESSION_MISMATCH',
        'Consent policy differs from the retained page',
      );
    return prior.result;
  }
  const result: ConsentResult = {
    policy,
    outcome: policy === 'off' ? 'off' : 'not_detected',
    version: 'autoconsent-17.3.0+local-1',
  };
  let stopped = false;
  bridges.set(page, {
    policy,
    result,
    stop: () => {
      stopped = true;
    },
  });
  if (policy === 'off') return result;
  const { script, rules } = assets();
  const send = async (frame: Frame, message: object) => {
    if (stopped || frame.isDetached()) return;
    await frame
      .evaluate(
        (msg) => (window as any).autoconsentReceiveMessage?.(msg),
        message,
      )
      .catch(() => {});
  };
  let messages = 0;
  await page.exposeBinding(
    'autoconsentSendMessage',
    async ({ frame }, message) => {
      if (
        stopped ||
        !message ||
        typeof message !== 'object' ||
        ++messages > 1000
      )
        return;
      switch (message.type) {
        case 'init':
          return send(frame, {
            type: 'initResp',
            rules,
            config: {
              enabled: true,
              autoAction: automatic
                ? policy === 'acceptAll'
                  ? 'optIn'
                  : 'optOut'
                : null,
              disabledCmps: [],
              enablePrehide: false,
              enableCosmeticRules: false,
              enableGeneratedRules: false,
              enableHeuristicDetection: false,
              enablePopupMutationObserver: false,
              detectRetries: 5,
              prehideTimeout: 0,
              isMainWorld: true,
              visualTest: false,
              logs: {
                lifecycle: false,
                rulesteps: false,
                detectionsteps: false,
                evals: false,
                errors: false,
                messages: false,
                waits: false,
              },
            },
          });
        case 'cmpDetected':
        case 'popupFound':
          result.cmp = String(message.cmp).slice(0, 128);
          result.outcome = 'unresolved';
          break;
        case 'optOutResult':
        case 'optInResult':
          result.cmp = String(message.cmp).slice(0, 128);
          result.outcome = message.result === true ? 'applied' : 'unresolved';
          if (message.scheduleSelfTest) void send(frame, { type: 'selfTest' });
          break;
        case 'selfTestResult':
          result.selfTest = message.result === true;
          if (!result.selfTest) result.outcome = 'unresolved';
          break;
        case 'eval':
          return send(frame, {
            type: 'evalResp',
            id: String(message.id).slice(0, 128),
            result: false,
          });
      }
    },
  );
  await page.addInitScript({ content: script });
  for (const frame of page.frames())
    await frame.evaluate(script).catch(() => {});
  page.once('close', () => {
    stopped = true;
  });
  return result;
};

export const stopConsent = (page: Page) => bridges.get(page)?.stop();

export const applyConsent = async (
  page: Page,
  policy: ConsentPolicy,
  deadline: Deadline,
) => {
  const result =
    bridges.get(page)?.result ?? (await prepareConsent(page, policy));
  if (policy === 'off') return result;
  // Explicit CMP controls also cover rule sets that require main-world eval.
  // Only known CMP containers are considered; ambiguous generic buttons are not.
  const controls =
    policy === 'rejectNonEssential'
      ? [
          ['#onetrust-banner-sdk', '#onetrust-reject-all-handler', 'OneTrust'],
          [
            '#CybotCookiebotDialog',
            '#CybotCookiebotDialogBodyButtonDecline',
            'Cookiebot',
          ],
          ['#didomi-host', '#didomi-notice-disagree-button', 'Didomi'],
          ['#bnp_container', '#bnp_btn_reject', 'Bing'],
        ]
      : [
          ['#onetrust-banner-sdk', '#onetrust-accept-btn-handler', 'OneTrust'],
          [
            '#CybotCookiebotDialog',
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
            'Cookiebot',
          ],
          ['#didomi-host', '#didomi-notice-agree-button', 'Didomi'],
          ['#bnp_container', '#bnp_btn_accept', 'Bing'],
        ];
  for (const frame of page.frames())
    for (const [container, button, cmp] of controls) {
      const overlay = frame.locator(container);
      if (!(await overlay.isVisible().catch(() => false))) continue;
      result.cmp = cmp;
      result.outcome = 'unresolved';
      const control = frame.locator(button);
      if ((await control.count()) !== 1 || !(await control.isVisible()))
        continue;
      await control
        .click({ timeout: Math.min(1500, deadline.remaining()) })
        .catch(() => {});
      await overlay
        .waitFor({
          state: 'hidden',
          timeout: Math.min(1000, deadline.remaining()),
        })
        .catch(() => {});
      if (!(await overlay.isVisible().catch(() => false)))
        result.outcome = 'applied';
    }
  return result;
};

export const countryDestination = (
  current: string,
  href: string,
): string | null => {
  const base = new URL(current);
  const next = new URL(href, current);
  if (
    base.hostname !== 'www.bestbuy.com' ||
    next.origin !== base.origin ||
    next.pathname !== base.pathname ||
    next.searchParams.get('skuId') !== base.searchParams.get('skuId') ||
    next.searchParams.get('intl') !== 'nosplash'
  )
    return null;
  return next.href;
};

export const applyWorkflow = async (
  page: Page,
  workflow: Workflow,
  deadline: Deadline,
) => {
  const steps: { type: string; outcome: string }[] = [];
  const url = new URL(page.url());
  if (
    (workflow === 'auto' || workflow === 'bestbuy-us@1') &&
    url.hostname === 'www.bestbuy.com'
  ) {
    if (
      /choose a country|select your country/i.test(
        await page.locator('body').innerText(),
      )
    ) {
      for (const href of await page
        .locator('a[href]')
        .evaluateAll((links) =>
          links.map((link) => (link as HTMLAnchorElement).href),
        )) {
        const next = countryDestination(page.url(), href);
        if (!next) continue;
        await page.goto(next, {
          waitUntil: 'domcontentloaded',
          timeout: deadline.remaining(),
        });
        steps.push({
          type: 'country-selection',
          outcome: 'navigated-original-product',
        });
        break;
      }
    }
  }
  if (
    (workflow === 'auto' || workflow === 'product-details@1') &&
    /(^|\.)canadagoose\.com$/.test(url.hostname)
  ) {
    const details = page.getByRole('button', {
      name: /^(product )?details|^description$/i,
    });
    if ((await details.count()) === 1 && (await details.isVisible())) {
      if ((await details.getAttribute('aria-expanded')) === 'false') {
        await details.click({ timeout: Math.min(2000, deadline.remaining()) });
        steps.push({ type: 'product-details', outcome: 'expanded' });
      }
    }
  }
  return { id: workflow, steps };
};

export const runActions = async (
  page: Page,
  actions: BrowserAction[],
  deadline: Deadline,
) => {
  const scrapes: { url: string; html: string }[] = [];
  for (const action of actions) {
    const timeout = () => Math.min(5000, deadline.remaining());
    if (action.type === 'click')
      await page.locator(action.selector).click({ timeout: timeout() });
    if (action.type === 'wait') {
      if (action.selector)
        await page
          .locator(action.selector)
          .waitFor({ state: 'visible', timeout: timeout() });
      else await deadline.sleep(action.milliseconds!);
    }
    if (action.type === 'write')
      await deadline.run(page.keyboard.insertText(action.text));
    if (action.type === 'press')
      await deadline.run(page.keyboard.press(action.key));
    if (action.type === 'scroll') {
      if (action.selector)
        await page
          .locator(action.selector)
          .scrollIntoViewIfNeeded({ timeout: timeout() });
      await deadline.run(
        page.mouse.wheel(0, action.direction === 'up' ? -600 : 600),
      );
    }
    if (action.type === 'scrape')
      scrapes.push({
        url: page.url(),
        html: await deadline.run(page.content()),
      });
  }
  return { screenshots: [], javascriptReturns: [], pdfs: [], scrapes };
};

export const interactionState = (
  text: string,
  url: string,
  ready: boolean,
  status: number | null,
  challenge: boolean,
) => {
  if (/\/accounts\/login|\/signin(?:[/?]|$)/i.test(url)) return 'AUTH_REQUIRED';
  if (/not available in your location/i.test(text)) return 'REGION_UNAVAILABLE';
  if (
    /prove your humanity|verify you are human|security verification|human verification|complete the challenge/i.test(
      text,
    )
  )
    return 'HUMAN_REQUIRED';
  if (challenge) return 'VERIFICATION_REQUIRED';
  if (status === 403) return 'ACCESS_DENIED';
  if (/choose a country|select your country/i.test(text))
    return 'COUNTRY_SELECTION';
  return ready ? 'CONTENT_READY' : 'CONTENT_NOT_READY';
};
