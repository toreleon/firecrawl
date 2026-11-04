import type { Page, Frame } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Deadline, ScrapeFailure, errorCode } from './scrape-control';
import { waitForRenderedBody } from './page-readiness';
import {
  rejectOneTrustPreferences,
  OneTrustPreferencesResult,
} from './onetrust-preferences';

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
  preferenceCenter?: OneTrustPreferencesResult;
  version: string;
  diagnostics?: {
    framesScanned: number;
    probeTimeouts: number;
    mainFrameProbeTimeouts: number;
    auxiliaryProbeTimeouts: number;
    probeErrors: number;
    actionErrors: number;
    limited: boolean;
    durationMs: number;
  };
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
    version: 'autoconsent-17.3.0+local-3',
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
  const started = Date.now();
  const scan = new Deadline(
    Math.min(5000, Math.max(1, deadline.remaining() - 300)),
  );
  const diagnostics = {
    framesScanned: 0,
    probeTimeouts: 0,
    mainFrameProbeTimeouts: 0,
    auxiliaryProbeTimeouts: 0,
    probeErrors: 0,
    actionErrors: 0,
    limited: false,
    durationMs: 0,
  };
  result.diagnostics = diagnostics;
  // Only read-only discovery is raced. An expired query has no continuation
  // that can click later, including after a retained tab enters human handoff.
  const probe = async <T>(
    operation: (budget: Deadline) => Promise<T>,
    primary: boolean,
  ): Promise<{ value: T } | null> => {
    const remaining = deadline.remaining();
    let left = 0;
    try {
      left = scan.remaining();
    } catch {
      /* The discovery window ended. */
    }
    if (remaining <= 300 || left <= 0) {
      diagnostics.limited = true;
      if (result.outcome === 'not_detected') result.outcome = 'unresolved';
      return null;
    }
    const budget = new Deadline(
      Math.min(primary ? 3000 : 1000, left, remaining - 300),
    );
    try {
      return { value: await budget.run(operation(budget)) };
    } catch (error) {
      deadline.remaining(); // Propagate caller expiry/cancellation instead of hiding it.
      if (errorCode(error) === 'SCRAPE_TIMEOUT') {
        diagnostics.probeTimeouts++;
        if (primary) diagnostics.mainFrameProbeTimeouts++;
        else diagnostics.auxiliaryProbeTimeouts++;
      } else diagnostics.probeErrors++;
      if (result.outcome === 'not_detected') result.outcome = 'unresolved';
      return null;
    }
  };
  try {
    for (const frame of page.frames()) {
      if (diagnostics.limited) break;
      if (frame.isDetached()) continue;
      diagnostics.framesScanned++;
      const remaining = [...controls];
      while (remaining.length) {
        const found = await probe(async (budget) => {
          const check = () => {
            deadline.remaining();
            budget.remaining();
          };
          // One utility-world query replaces four separate visibility RPCs on
          // frames without a CMP. Preserve shadow-root locator semantics.
          const visible = frame
            .locator(remaining.map((c) => c[0]).join(','))
            .filter({ visible: true })
            .first();
          if (!(await visible.isVisible())) return null;
          check();
          const id = await visible.getAttribute('id', {
            timeout: budget.remaining(),
          });
          check();
          const choice = remaining.find((c) => c[0] === '#' + id);
          if (!choice) return null;
          const control = frame.locator(choice[1]);
          const count = await control.count();
          check();
          const clickable = count === 1 && (await control.isVisible());
          check();
          return { choice, control, clickable };
        }, frame === page.mainFrame());
        if (!found?.value) break;
        const { choice, control, clickable } = found.value;
        remaining.splice(remaining.indexOf(choice), 1);
        const [container, , cmp] = choice;
        result.cmp = cmp;
        result.outcome = 'unresolved';
        if (!clickable) {
          if (cmp === 'OneTrust' && policy === 'rejectNonEssential') {
            result.preferenceCenter = await rejectOneTrustPreferences(
              frame,
              deadline,
            );
            if (result.preferenceCenter.outcome === 'applied')
              result.outcome = 'applied';
          }
          continue;
        }
        deadline.remaining();
        await control
          .click({ timeout: Math.min(1500, deadline.remaining()) })
          .catch(() => {
            diagnostics.actionErrors++;
          });
        const hidden = await frame
          .locator(container)
          .waitFor({
            state: 'hidden',
            timeout: Math.min(1000, deadline.remaining()),
          })
          .then(
            () => true,
            () => false,
          );
        if (hidden) result.outcome = 'applied';
      }
    }
    return result;
  } finally {
    diagnostics.durationMs = Date.now() - started;
  }
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

export const amazonProductIdentity = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    !['amazon.com', 'www.amazon.com'].includes(url.host) ||
    url.username ||
    url.password
  )
    return null;
  return (
    url.pathname
      .match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]
      .toUpperCase() ?? null
  );
};

export const amazonHomepageNavigationInterruption = (
  error: unknown,
  requested: string,
  landed: string,
) => {
  if (!(error instanceof Error) || !amazonProductIdentity(requested))
    return false;
  try {
    const entry = new URL(requested);
    const after = new URL(landed);
    return (
      after.origin === entry.origin &&
      after.pathname === '/' &&
      !after.username &&
      !after.password &&
      error.message.split('\n')[0] ===
        `page.goto: Navigation to "${entry.href}" is interrupted by another navigation to "${after.href}"`
    );
  } catch {
    return false;
  }
};

export const amazonContinuationAllowed = (
  current: string,
  form: {
    action: string;
    method: string;
    formCount: number;
    buttonCount: number;
    prompt: boolean;
    shortPage: boolean;
    otherControls: boolean;
    inputs: { name: string; type: string }[];
  },
) => {
  if (!amazonProductIdentity(current)) return false;
  const entry = new URL(current);
  if (
    ![
      '/errors_page/validateCaptcha',
      entry.origin + '/errors_page/validateCaptcha',
    ].includes(form.action)
  )
    return false;
  const action = new URL(form.action, current);
  return (
    action.origin === entry.origin &&
    action.pathname === '/errors_page/validateCaptcha' &&
    !action.search &&
    !action.hash &&
    form.method.toLowerCase() === 'get' &&
    form.formCount === 1 &&
    form.buttonCount === 1 &&
    form.prompt &&
    form.shortPage &&
    !form.otherControls &&
    form.inputs.length === 3 &&
    form.inputs.every((input) => input.type === 'hidden') &&
    JSON.stringify(form.inputs.map((input) => input.name).sort()) ===
      JSON.stringify(['amzn', 'amzn-r', 'field-keywords'])
  );
};

type ProductDetailsObservation = {
  outcome:
    | 'not_found'
    | 'ambiguous'
    | 'not_collapsible'
    | 'already_expanded'
    | 'expanded'
    | 'unresolved';
  phase: 'probe' | 'click' | 'confirm';
  reason?:
    | 'insufficient_budget'
    | 'not_visible'
    | 'probe_timeout'
    | 'action_timeout'
    | 'expansion_unconfirmed';
  candidateCount?: number;
  clickAttempted: boolean;
  clickCompleted: boolean;
  durationMs: number;
};

/** An optional accordion must not discard a document when its native click fails. */
export const expandProductDetails = async (
  page: Page,
  deadline: Deadline,
): Promise<ProductDetailsObservation> => {
  const started = Date.now();
  const result: ProductDetailsObservation = {
    outcome: 'not_found',
    phase: 'probe',
    clickAttempted: false,
    clickCompleted: false,
    durationMs: 0,
  };
  const details = page.getByRole('button', {
    name: /^(product )?details|^description$/i,
  });
  // Only read-only probes are raced. Check each result before another RPC;
  // an expired probe has no continuation that can click a retained tab later.
  const inspect = async (budget: Deadline) => {
    const check = () => {
      deadline.remaining();
      budget.remaining();
    };
    check();
    const count = await details.count();
    check();
    if (count !== 1) return { count, visible: false, expanded: null };
    const visible = await details.isVisible();
    check();
    const expanded = visible
      ? await details.getAttribute('aria-expanded', {
          timeout: budget.remaining(),
        })
      : null;
    check();
    return { count, visible, expanded };
  };
  try {
    if (deadline.remaining() <= 300) {
      result.outcome = 'unresolved';
      result.reason = 'insufficient_budget';
      return result;
    }
    const probe = new Deadline(Math.min(1000, deadline.remaining() - 300));
    const before = await probe.run(inspect(probe));
    result.candidateCount = before.count;
    if (before.count === 0) return result;
    if (before.count > 1) {
      result.outcome = 'ambiguous';
      return result;
    }
    if (!before.visible) {
      result.outcome = 'unresolved';
      result.reason = 'not_visible';
      return result;
    }
    if (before.expanded !== 'false') {
      result.outcome =
        before.expanded === 'true' ? 'already_expanded' : 'not_collapsible';
      return result;
    }
    result.phase = 'click';
    if (deadline.remaining() <= 300) {
      result.outcome = 'unresolved';
      result.reason = 'insufficient_budget';
      return result;
    }
    result.clickAttempted = true;
    // Await the native operation's own timeout; racing a separate short timer
    // here could report completion while a late click is still queued.
    await details.click({ timeout: Math.min(2000, deadline.remaining() - 300) });
    result.clickCompleted = true;
    deadline.remaining();
    result.phase = 'confirm';
    const confirm = new Deadline(
      Math.min(1000, Math.max(1, deadline.remaining() - 300)),
    );
    await confirm.run(
      (async () => {
        while (true) {
          const after = await inspect(confirm);
          if (after.count === 1 && after.visible && after.expanded === 'true')
            return;
          await confirm.sleep(50);
        }
      })(),
    );
    result.outcome = 'expanded';
    return result;
  } catch (error) {
    deadline.remaining(); // Caller expiry and cancellation remain terminal.
    const timeout =
      (error instanceof ScrapeFailure && error.code === 'SCRAPE_TIMEOUT') ||
      (error instanceof Error && error.name === 'TimeoutError');
    if (!timeout) throw error;
    result.outcome = 'unresolved';
    result.reason =
      result.phase === 'probe'
        ? 'probe_timeout'
        : result.phase === 'click'
          ? 'action_timeout'
          : 'expansion_unconfirmed';
    return result;
  } finally {
    result.durationMs = Date.now() - started;
  }
};

export const applyWorkflow = async (
  page: Page,
  workflow: Workflow,
  deadline: Deadline,
  onPhase?: (
    phase:
      | 'workflow-country-text'
      | 'workflow-country-links'
      | 'workflow-country-navigation',
  ) => void,
) => {
  const steps: { type: string; outcome: string }[] = [];
  const url = new URL(page.url());
  const observations: {
    entryHost: string;
    productDetails?: ProductDetailsObservation;
    amazonContinuation?: {
      origin: string;
      asin: string;
      settleWaitMs?: number;
    };
    countrySelection?: {
      observed: boolean;
      candidateCount: number;
      waitMs: number;
      discoveryTimeoutMs: number;
      navigationTimeoutMs?: number;
    };
  } = { entryHost: url.hostname };
  if (workflow === 'auto' && amazonProductIdentity(url.href)) {
    const forms = page.locator('form');
    const formCount = await forms.count();
    if (formCount === 1) {
      const form = forms.first();
      const button = form.getByRole('button', {
        name: 'Continue shopping',
        exact: true,
      });
      const buttonCount = await button.count();
      const info = await form.evaluate((element) => {
        const form = element as HTMLFormElement;
        const text = document.body?.innerText ?? '';
        return {
          action: form.getAttribute('action') ?? '',
          method: form.method,
          prompt: /click the button below to continue shopping/i.test(text),
          shortPage: text.length <= 2000,
          otherControls:
            !!form.querySelector(
              'textarea,select,[contenteditable="true"],input:not([type="hidden"])',
            ) || !!document.querySelector('iframe'),
          inputs: Array.from(form.querySelectorAll('input')).map((input) => ({
            name: input.name,
            type: input.type,
          })),
        };
      });
      if (
        amazonContinuationAllowed(url.href, {
          ...info,
          formCount,
          buttonCount,
        }) &&
        (await button.isVisible()) &&
        (await button.isEnabled())
      ) {
        observations.amazonContinuation = {
          origin: url.origin,
          asin: amazonProductIdentity(url.href)!,
        };
        // One native GET submission, with opaque hidden fields left in the DOM.
        // No answer-required control is clicked or filled by this recipe.
        // Register before clicking: load state can still describe the old
        // product document while its GET submission is waiting to commit.
        const navigation = page.waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: Math.min(5000, deadline.remaining()),
        });
        await Promise.all([
          navigation,
          button.click({ timeout: Math.min(5000, deadline.remaining()) }),
        ]);
        await page.waitForLoadState('domcontentloaded', {
          timeout: Math.min(5000, deadline.remaining()),
        });
        let after = new URL(page.url());
        let pendingVerification = 1;
        const settleStart = Date.now();
        const settleEnd =
          settleStart + Math.min(5000, Math.max(1, deadline.remaining() - 300));
        do {
          try {
            const snapshot = await deadline.run(page.evaluate(() => ({
              url: location.href,
              pending: document.querySelectorAll(
                'form[action*="/errors_page/validateCaptcha"],#captchacharacters,input[name="field-keywords"]:not([type="hidden"]),iframe[src*="captcha"]',
              ).length,
            })));
            if (snapshot.url !== page.url()) {
              await deadline.sleep(50);
              continue;
            }
            after = new URL(snapshot.url);
            pendingVerification = snapshot.pending;
            const product = amazonProductIdentity(after.href);
            if (
              after.origin !== url.origin ||
              (product !== null && product !== amazonProductIdentity(url.href))
            )
              throw new ScrapeFailure(
                'WORKFLOW_NAVIGATION_MISMATCH',
                'Amazon continuation changed the requested product or origin',
              );
            if (
              !pendingVerification &&
              (after.pathname === '/' || product !== null)
            )
              break;
          } catch (error) {
            if (
              !/Execution context was destroyed|navigating/i.test(String(error))
            )
              throw error;
          }
          if (Date.now() >= settleEnd) break;
          await deadline.sleep(
            Math.min(100, Math.max(1, settleEnd - Date.now())),
          );
        } while (Date.now() <= settleEnd);
        observations.amazonContinuation.settleWaitMs = Date.now() - settleStart;
        if (
          after.origin !== url.origin ||
          (amazonProductIdentity(after.href) !== null &&
            amazonProductIdentity(after.href) !==
              amazonProductIdentity(url.href)) ||
          (after.pathname !== '/' &&
            !pendingVerification &&
            amazonProductIdentity(after.href) !==
              amazonProductIdentity(url.href))
        )
          throw new ScrapeFailure(
            'WORKFLOW_NAVIGATION_MISMATCH',
            'Amazon continuation changed the requested product or origin',
          );
        if (pendingVerification)
          steps.push({
            type: 'amazon-continue@1',
            outcome: 'verification_unresolved',
          });
        else {
          if (after.pathname === '/') {
            await waitForRenderedBody(page, deadline, 1500);
            try {
              await page.goto(url.href, {
                waitUntil: 'domcontentloaded',
                timeout: deadline.remaining(),
              });
            } catch (error) {
              deadline.remaining();
              // WebKit can report the homepage's overlapping navigation before
              // the final identity check runs. Preserve this known mismatch so
              // the API can use its existing closed-Page alternate policy.
              if (
                amazonHomepageNavigationInterruption(error, url.href, page.url())
              )
                throw new ScrapeFailure(
                  'WORKFLOW_NAVIGATION_MISMATCH',
                  'Amazon original-product return was interrupted by its homepage',
                );
              throw error;
            }
          }
          if (
            amazonProductIdentity(page.url()) !==
              amazonProductIdentity(url.href) ||
            new URL(page.url()).origin !== url.origin
          )
            throw new ScrapeFailure(
              'WORKFLOW_NAVIGATION_MISMATCH',
              'Amazon continuation did not return to the requested product',
            );
          steps.push({
            type: 'amazon-continue@1',
            outcome:
              after.pathname === '/'
                ? 'submitted-and-returned-to-product'
                : 'submitted-original-product',
          });
        }
      }
    }
  }
  if (
    (workflow === 'auto' || workflow === 'bestbuy-us@1') &&
    url.hostname === 'www.bestbuy.com'
  ) {
    // Prompt hydration and deep-link rewriting are separate. Wait for a link
    // that passes the same identity check used for navigation, not any US link.
    const started = Date.now();
    const discoveryTimeoutMs = Math.min(
      5000,
      Math.max(1, deadline.remaining() - 300),
    );
    const end = started + discoveryTimeoutMs;
    const discovery = new Deadline(discoveryTimeoutMs);
    const canDiscover = () => {
      deadline.remaining();
      return Date.now() < end;
    };
    let destination: string | null = null;
    let observed = false;
    let candidateCount = 0;
    do {
      if (!canDiscover()) break;
      onPhase?.('workflow-country-text');
      const text = await deadline.run(
        discovery.run(page.evaluate(() => document.body?.innerText ?? '')),
      );
      // A completed read may be delivered as the discovery window closes.
      // Discard that result without failing the remaining caller budget or
      // starting another RPC. A stuck read still rejects via discovery.run.
      if (!canDiscover()) break;
      if (/choose\s+a\s+country|select\s+your\s+country/i.test(text)) {
        observed = true;
        onPhase?.('workflow-country-links');
        const links = await deadline.run(
          discovery.run(
            page
              .locator('a[href]')
              .evaluateAll((links) =>
                links.map((link) => (link as HTMLAnchorElement).href),
              ),
          ),
        );
        if (!canDiscover()) break;
        candidateCount = links.length;
        for (const href of links) {
          destination = countryDestination(url.href, href);
          if (destination) break;
        }
      }
      if (destination) break;
      if (Date.now() < end)
        await deadline.sleep(Math.min(100, end - Date.now()));
    } while (Date.now() < end);
    deadline.remaining();
    observations.countrySelection = {
      observed,
      candidateCount,
      waitMs: Date.now() - started,
      discoveryTimeoutMs,
    };
    if (destination && canDiscover()) {
      if (deadline.remaining() <= 300)
        throw new ScrapeFailure(
          'SCRAPE_TIMEOUT',
          'Insufficient country-navigation budget',
        );
      const navigationTimeoutMs = Math.min(30000, deadline.remaining() - 300);
      observations.countrySelection.navigationTimeoutMs = navigationTimeoutMs;
      onPhase?.('workflow-country-navigation');
      // Await the native navigation timeout. An unfinished navigation fails
      // before capture; existing Page-close proof remains required for fallback.
      await page.goto(destination, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs,
      });
      deadline.remaining();
      steps.push({
        type: 'country-selection',
        outcome: 'navigated-original-product',
      });
    } else if (observed)
      steps.push({
        type: 'country-selection',
        outcome: 'destination_not_ready',
      });
  }
  if (
    (workflow === 'auto' || workflow === 'product-details@1') &&
    /(^|\.)canadagoose\.com$/.test(url.hostname)
  ) {
    const details = await expandProductDetails(page, deadline);
    observations.productDetails = details;
    if (details.outcome === 'expanded' || details.outcome === 'unresolved')
      steps.push({ type: 'product-details', outcome: details.outcome });
  }
  if (
    workflow === 'auto' &&
    ['coinmarketcap.com', 'www.coinmarketcap.com'].includes(url.hostname) &&
    /^\/currencies\/[^/]+\/?$/.test(url.pathname)
  ) {
    // This section hydrates on intersection. A real scroll exposes the public
    // overview; copying its hidden SSR text would not establish body readiness.
    const about = page.locator(
      '#section-coin-about[data-test="section-about"]',
    );
    if ((await about.count()) === 1 && (await about.isVisible())) {
      await about.scrollIntoViewIfNeeded({
        timeout: Math.min(2000, deadline.remaining()),
      });
      steps.push({ type: 'coin-about@1', outcome: 'scrolled-into-view' });
    }
  }
  return { id: workflow, steps, observations };
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
  interactive = false,
  denied = false,
) => {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    // A malformed URL cannot establish a dedicated authentication route.
  }
  if (
    /\/accounts\/login(?:\/|$)|\/signin(?:\/|$)/i.test(path) ||
    (/^\/(?:login|log-in|sign-in)(?:\.html?)?\/?$/i.test(path) &&
      /\b(?:sign|log)[\s-]+in\b/i.test(text))
  )
    return 'AUTH_REQUIRED';
  if (/not available in your location/i.test(text)) return 'REGION_UNAVAILABLE';
  if (denied) return 'ACCESS_DENIED';
  if (
    interactive ||
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
