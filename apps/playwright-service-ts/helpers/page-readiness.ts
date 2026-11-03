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

/** Wait for rendered content or passive challenge completion, without an oracle marker. */
export const waitForRenderedBody = async (
  page: Page,
  deadline: Deadline,
  timeoutMs: number,
) => {
  const started = Date.now();
  const budget = Math.min(timeoutMs, Math.max(1, deadline.remaining() - 300));
  const end = started + budget;
  let outcome: 'empty' | 'loading' | 'ready' | 'verification' | 'navigating' =
    'empty';
  do {
    try {
      const snapshot = await deadline.run(
        page.evaluate(() => ({
          text: document.body?.innerText ?? '',
          html: document.documentElement?.outerHTML ?? '',
        })),
      );
      outcome = renderedBodyState(snapshot.text);
      const protection = detectPageProtection(snapshot.html);
      if (protection) {
        outcome = 'verification';
        if (
          protection.provider === 'amazon' ||
          /prove your humanity|verify (?:that )?you are human|complete the challenge|enter the characters/i.test(
            snapshot.text,
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
  };
};
