import type { Page } from 'playwright';
import { BotDetection, detectBotChallenge } from './bot-detection';
import { Deadline } from './scrape-control';

/** Additional runtime classifications; the frozen benchmark fallback is unchanged. */
export const detectPageProtection = (
  html: string,
  headers: Record<string, string> = {},
): BotDetection | undefined => {
  const known = detectBotChallenge(html, headers);
  if (known) return known;
  if (html.length > 65536) return;
  const markup = html.replace(
    /<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  if (
    /<form\b[^>]*\bid=["']captcha-form["']/i.test(markup) &&
    /\bclass=["'][^"']*\bg-recaptcha\b/i.test(markup) &&
    /our systems have detected unusual traffic from your computer network/i.test(
      markup,
    )
  )
    return {
      provider: 'google',
      reason: 'Google unusual-traffic verification form',
    };
  if (
    /<form\b[^>]*\baction=["'](?:https:\/\/(?:www\.)?amazon\.com)?\/errors_page\/validateCaptcha["']/i.test(
      markup,
    ) &&
    /click the button below to continue shopping|enter the characters you see below/i.test(
      markup,
    )
  )
    return {
      provider: 'amazon',
      reason: 'Amazon continuation or answer-required verification form',
    };
  if (
    /\bid=["']sec-if-cpt-container["']/i.test(markup) &&
    /\bid=["']sec-bc-tile-container["']/i.test(markup) &&
    /\bid=["']progress-button["']/i.test(markup) &&
    /\bclass=["'][^"']*\bscf-akamai-logo\b/i.test(markup)
  )
    return {
      provider: 'akamai',
      reason: 'Akamai behavioral verification interstitial',
    };
};

export const renderedBodyState = (
  text: string,
): 'empty' | 'loading' | 'ready' => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'empty';
  return /^(?:loading|please wait)[\s.!…]*$/i.test(normalized)
    ? 'loading'
    : 'ready';
};

/** Runs inside the renderer. Capture content and loading signals in one revision. */
export function captureRenderedPage({
  text,
  selector,
  scope,
  automatic,
}: {
  text?: string;
  selector?: string;
  scope?: 'body' | 'title';
  automatic?: boolean;
}) {
  let selectorReady = true;
  if (selector) {
    try {
      const element = document.querySelector(selector);
      const style = element && getComputedStyle(element);
      selectorReady =
        !!element &&
        style?.display !== 'none' &&
        style?.visibility !== 'hidden' &&
        !!element.getClientRects().length;
    } catch {
      selectorReady = true;
    }
  }
  let busyCount = 0;
  let ignoredComplementaryBusyCount = 0;
  let busyScope: 'main' | 'body' = 'body';
  if (automatic) {
    const primary = Array.from(
      document.querySelectorAll('main,[role="main"]'),
    ).filter((element) => {
      const style = getComputedStyle(element);
      return (
        !element.closest('[aria-hidden="true"],[inert]') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0
      );
    });
    if (primary.length) busyScope = 'main';
    for (const element of Array.from(
      document.querySelectorAll('[aria-busy="true"]'),
    )) {
      if (
        primary.length &&
        !primary.some(
          (main) => main.contains(element) || element.contains(main),
        )
      )
        continue;
      if (element.closest('[aria-hidden="true"],[inert]')) continue;
      // Explicit ad placeholders may remain busy because advertising is blocked.
      // They do not describe loading of the requested editorial/product content.
      const ad = element.closest('[data-ad-status][role="region"][aria-label]');
      if (ad && /\badvertisement$/i.test(ad.getAttribute('aria-label') ?? ''))
        continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // Lazy offscreen widgets must not keep otherwise ready visible content busy.
      if (
        Array.from(element.getClientRects()).some(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.right > 0 &&
            r.top < innerHeight &&
            r.left < innerWidth,
        )
      ) {
        // Supporting landmarks can sit inside a site's broad main wrapper.
        // They do not describe primary loading, but body fallback and any
        // primary landmark nested inside them must retain the busy signal.
        const supporting = element.closest(
          'aside:not([role]),[role="complementary"]',
        );
        const contexts = primary.filter(
          (main) => main.contains(element) || element.contains(main),
        );
        if (
          supporting &&
          contexts.length &&
          contexts.every(
            (main) => main !== supporting && main.contains(supporting),
          )
        ) {
          ignoredComplementaryBusyCount++;
          continue;
        }
        busyCount++;
      }
    }
  }
  const renderedText = document.body?.innerText ?? '';
  return {
    content: document.documentElement?.outerHTML ?? '',
    renderedText,
    title: document.title,
    url: location.href,
    busyCount,
    ignoredComplementaryBusyCount,
    busyScope,
    ready:
      selectorReady &&
      (!text ||
        (scope === 'title' ? document.title : renderedText)
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()
          .includes(text.toLowerCase().replace(/\s+/g, ' ').trim())),
  };
}

/** Wait for rendered content or passive challenge completion, without an oracle marker. */
export const waitForRenderedBody = async (
  page: Page,
  deadline: Deadline,
  timeoutMs: number,
) => {
  const started = Date.now();
  const budget = Math.min(timeoutMs, Math.max(1, deadline.remaining() - 300));
  const end = started + budget;
  let outcome:
    | 'empty'
    | 'loading'
    | 'busy'
    | 'ready'
    | 'verification'
    | 'navigating' = 'empty';
  let busyCount = 0,
    maxBusyCount = 0;
  let ignoredComplementaryBusyCount = 0;
  let busyScope: 'main' | 'body' = 'body';
  do {
    try {
      const snapshot = await deadline.run(
        page.evaluate(captureRenderedPage, { automatic: true }),
      );
      busyCount = snapshot.busyCount;
      ignoredComplementaryBusyCount = snapshot.ignoredComplementaryBusyCount;
      maxBusyCount = Math.max(maxBusyCount, busyCount);
      busyScope = snapshot.busyScope;
      outcome = busyCount ? 'busy' : renderedBodyState(snapshot.renderedText);
      const protection = detectPageProtection(snapshot.content);
      if (protection) {
        outcome = 'verification';
        if (
          ['amazon', 'google'].includes(protection.provider) ||
          /prove your humanity|verify (?:that )?you are human|complete the challenge|enter the characters/i.test(
            snapshot.renderedText,
          )
        )
          break;
      } else if (outcome === 'ready') break;
    } catch (error) {
      if (!/Execution context was destroyed|navigating/i.test(String(error)))
        throw error;
      outcome = 'navigating';
    }
    if (Date.now() >= end) break;
    await deadline.sleep(Math.min(100, Math.max(1, end - Date.now())));
  } while (Date.now() <= end);
  return {
    mode: 'rendered-body' as const,
    outcome,
    waitMs: Date.now() - started,
    timeoutMs: budget,
    busyCount,
    ignoredComplementaryBusyCount,
    maxBusyCount,
    busyScope,
  };
};
