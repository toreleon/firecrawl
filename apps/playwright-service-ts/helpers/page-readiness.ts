import type { Page } from 'playwright';
import { BotDetection, detectBotChallenge } from './bot-detection';
import { Deadline } from './scrape-control';

/** Additional runtime classifications; the frozen benchmark fallback is unchanged. */
export const detectPageProtection = (
  html: string,
  headers: Record<string, string> = {},
  url?: string,
): (BotDetection & {
  interactive?: true;
  passive?: true;
  denied?: true;
}) | undefined => {
  const awsAction = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'x-amzn-waf-action')?.[1]
    ?.toLowerCase();
  if (awsAction === 'captcha' || awsAction === 'challenge')
    return {
      provider: 'aws-waf',
      reason: `AWS WAF ${awsAction} response header`,
      ...(awsAction === 'captcha' && { interactive: true as const }),
    };
  const known = detectBotChallenge(html, headers);
  if (known)
    return ['perimeterx', 'captcha', 'reddit'].includes(known.provider)
      ? { ...known, interactive: true }
      : known;
  // The observed Alibaba interception includes ~98 KB of inline assets. Keep
  // this bounded check separate from the small-document signatures below.
  // A product page loading a CAPTCHA SDK is not an interception document.
  if (
    html.length <= 262144 &&
    /<title\b[^>]*>\s*Captcha Interception\s*<\/title>/i.test(html)
  ) {
    const structure = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<(script|style|noscript)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi,
        (_, tag: string, attrs: string) =>
          tag.toLowerCase() === 'script' ? `<script${attrs}></script>` : ' ',
      );
    const text = structure
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const scripts = Array.from(
      structure.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi),
      (match) => match[2],
    );
    const form = structure.match(
      /<form\b[^>]*\bid=["']nc-verify-form["'][^>]*>/i,
    )?.[0];
    const action = form?.match(/\baction=(["'])(.*?)\1/i)?.[2];
    let verificationPath = false;
    try {
      if (
        action &&
        (url || (action.startsWith('/') && !action.startsWith('//')))
      ) {
        const base = new URL(url ?? 'https://fixture.invalid');
        const destination = new URL(action, base);
        verificationPath =
          destination.origin === base.origin &&
          /\/_____tmd_____\/verify\/$/.test(destination.pathname);
      }
    } catch {
      /* An invalid action cannot establish the verification route. */
    }
    if (
      /<title\b[^>]*>\s*Captcha Interception\s*<\/title>/i.test(structure) &&
      /<div\b[^>]*\bid=["']baxia-punish["']/i.test(structure) &&
      verificationPath &&
      text.length < 2000 &&
      /sorry,\s*we have detected unusual traffic from your network\./i.test(
        text,
      ) &&
      scripts.some((src) =>
        /^(?:https:)?\/\/g\.alicdn\.com\/AWSC\/CAPTCHA\/[^?#]+\/awsc\.js(?:[?#]|$)/i.test(
          src,
        ),
      ) &&
      scripts.some((src) =>
        /^(?:https:)?\/\/g\.alicdn\.com\/bsop-static\/sufei-punish\/[^?#]+\/build\/punishpage\.min\.js(?:[?#]|$)/i.test(
          src,
        ),
      )
    )
      return {
        provider: 'alibaba',
        reason: 'Alibaba CAPTCHA interception document',
        interactive: true,
      };
  }
  if (html.length > 65536) return;
  const markup = html.replace(
    /<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  // Retain real script opening tags while removing their contents, comments
  // and styles. A quoted example inside an inline script is not a loaded SDK.
  const structure = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi,
      (_, tag: string, attrs: string) =>
        tag.toLowerCase() === 'script' ? `<script${attrs}></script>` : ' ',
    );
  const scripts = Array.from(
    structure.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi),
    (match) => match[2],
  );
  const hasScript = (pattern: RegExp) =>
    scripts.some((src) => pattern.test(src));
  const title =
    structure.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ??
    '';
  if (/^Autotrader\s*[-–]\s*page unavailable$/i.test(title)) {
    const bodyText = markup
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      bodyText.length < 3000 &&
      /we(?:'|&#39;|&apos;)re sorry for any inconvenience, but the site is currently unavailable\./i.test(
        bodyText,
      ) &&
      /\bIncident Number:\s*18\.[a-z0-9.-]+/i.test(bodyText) &&
      /<form\b[^>]*\bid=["']atcform["']/i.test(markup) &&
      /<link\b[^>]*\bhref=["']\/akamai-block\/block-images\/css\/app\.css["']/i.test(
        structure,
      ) &&
      hasScript(/^\/akamai-block\/block-images\/js\/app\.js(?:[?#]|$)/i)
    )
      return {
        provider: 'autotrader',
        reason: 'Autotrader unavailability block document',
        denied: true,
      };
  }
  const hasAwsCaptcha = hasScript(
    /^https:\/\/[a-z0-9.-]+\.(?:captcha|captcha-sdk)\.awswaf\.com\/[^<>"']*\/(?:captcha|jsapi)\.js(?:[?#]|$)/i,
  );
  if (
    hasAwsCaptcha &&
    ((/^Human Verification$/i.test(title) &&
      /\bid=["']captcha-container["']/i.test(markup)) ||
      (/^(?:\S+\s+)?Captcha$/i.test(title) &&
        hasScript(
          /^https:\/\/[a-z0-9.-]+\.token\.awswaf\.com\/[^<>"']*\/challenge\.js(?:[?#]|$)/i,
        ) &&
        markup
          .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
          .replace(/<[^>]+>/g, '')
          .trim().length < 512))
  )
    return {
      provider: 'aws-waf',
      reason: 'AWS WAF CAPTCHA interstitial',
      interactive: true,
    };
  if (
    /^Verifying Connection$/i.test(title) &&
    hasScript(
      /^https:\/\/[a-z0-9.-]+\.edge\.sdk\.awswaf\.com\/[^<>"']*\/challenge\.js(?:[?#]|$)/i,
    ) &&
    hasScript(/^\/interstitial\/interstitial\.js(?:[?#]|$)/i) &&
    /\bid=["']loading-state["']/i.test(markup) &&
    /\bid=["']status-text["']/i.test(markup) &&
    /please wait while we verify your browser\.|verified!\s*redirecting\.{3}/i.test(markup)
  )
    return {
      provider: 'aws-waf',
      reason: 'Passive AWS WAF connection verification interstitial',
      passive: true,
    };
  let path = '';
  try {
    if (url) path = new URL(url).pathname;
  } catch {
    // An absent/invalid URL cannot establish a dedicated verification route.
  }
  if (
    /\/sttc\/px\/captcha(?:-v\d+)?\/(?:index\.html)?$/i.test(path) &&
    /<(?:div|iframe)\b[^>]*\bid=["']px-captcha["']/i.test(markup)
  )
    return {
      provider: 'perimeterx',
      reason: 'HUMAN CAPTCHA container on a dedicated verification route',
      interactive: true,
    };
  if (
    /<form\b[^>]*\bid=["']destForm["']/i.test(markup) &&
    /checking your browser before you access eBay/i.test(markup) &&
    hasScript(
      /^https:\/\/ir\.ebaystatic\.com\/rs\/c\/challenge-[\w-]+\.js(?:[?#]|$)/i,
    )
  )
    return {
      provider: 'ebay',
      reason: 'eBay passive browser-check continuation document',
    };
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
  const normalized = text
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'empty';
  // Readiness text can span separate inline glyph nodes in animated labels.
  return /^(?:loading|pleasewait)[.!…]*$/i.test(normalized.replace(/\s/g, ''))
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
  let primary: Element[] = [];
  if (automatic) {
    primary = Array.from(
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
      const ad = element.closest(
        '[data-ad-status][role="region"][aria-label]',
      );
      if (
        ad &&
        /\badvertisement$/i.test(ad.getAttribute('aria-label') ?? '')
      )
        continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden')
        continue;
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
  const body = document.body;
  const bodyStyle = body && getComputedStyle(body);
  // innerText falls back to textContent for an unrendered element, including
  // inline script text. That fallback must not make a hidden/bootstrap body
  // ready. display:contents can have rendered children without its own box.
  const bodyRendered =
    !!body &&
    bodyStyle?.display !== 'none' &&
    bodyStyle?.contentVisibility !== 'hidden' &&
    (body.getClientRects().length > 0 ||
      (bodyStyle?.display === 'contents' &&
        document.documentElement.getClientRects().length > 0));
  const renderedText = bodyRendered ? body.innerText : '';
  let readinessText = renderedText;
  if (automatic) {
    // Navigation/footer labels and off-document font-measurement probes can
    // precede the actual page. Inspect primary text separately without changing
    // returned body text or explicit caller readiness. Below-fold content stays
    // eligible: these are document bounds, not viewport-only visibility checks.
    const roots = primary.length
      ? primary.filter(
          (element) =>
            !primary.some(
              (other) => other !== element && other.contains(element),
            ),
        )
      : bodyRendered
        ? [body!]
        : [];
    const chunks: string[] = [];
    let characters = 0,
      visited = 0;
    const range = document.createRange();
    const documentRoot = document.documentElement;
    const minX =
      documentRoot && getComputedStyle(documentRoot).direction === 'rtl'
        ? Math.min(
            0,
            documentRoot.clientWidth - documentRoot.scrollWidth,
          )
        : 0;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while (
        (node = walker.nextNode()) &&
        visited++ < 20000 &&
        characters < 4096
      ) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            'script,style,noscript,template,[aria-hidden="true"],[inert]',
          )
        )
          continue;
        const text = (node.textContent ?? '').replace(/\p{Cf}/gu, '').trim();
        if (!text) continue;
        const style = getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.visibility === 'collapse')
          continue;
        range.selectNodeContents(node);
        if (
          !Array.from(range.getClientRects()).some(
            (rect) =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.right + scrollX > minX &&
              rect.bottom + scrollY > 0,
          )
        )
          continue;
        const part = text.slice(0, 4096 - characters);
        chunks.push(part);
        characters += part.length;
      }
      if (visited >= 20000 || characters >= 4096) break;
    }
    readinessText = chunks.join(' ');
  }
  return {
    content: document.documentElement?.outerHTML ?? '',
    renderedText,
    readinessText,
    title: document.title,
    url: location.href,
    documentReadyState: document.readyState,
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
  headers: () => Record<string, string> = () => ({}),
  verificationPending: () => boolean = () => false,
) => {
  const started = Date.now();
  const budget = Math.min(
    timeoutMs,
    Math.max(1, deadline.remaining() - 300),
  );
  const end = started + budget;
  let outcome:
    | 'empty'
    | 'loading'
    | 'busy'
    | 'ready'
    | 'verification'
    | 'blocked'
    | 'navigating' = 'empty';
  let busyCount = 0,
    maxBusyCount = 0;
  let ignoredComplementaryBusyCount = 0;
  let busyScope: 'main' | 'body' = 'body';
  let documentReadyState: DocumentReadyState | undefined;
  do {
    try {
      const snapshot = await deadline.run(
        page.evaluate(captureRenderedPage, { automatic: true }),
      );
      busyCount = snapshot.busyCount;
      ignoredComplementaryBusyCount =
        snapshot.ignoredComplementaryBusyCount;
      maxBusyCount = Math.max(maxBusyCount, busyCount);
      busyScope = snapshot.busyScope;
      documentReadyState = snapshot.documentReadyState;
      outcome =
        documentReadyState === 'loading'
          ? 'loading'
          : busyCount
            ? 'busy'
            : renderedBodyState(snapshot.readinessText);
      const protection = detectPageProtection(
        snapshot.content,
        headers(),
        snapshot.url,
      );
      // An identified non-2xx verification document is not ready merely
      // because its script changes a status label before returning content.
      if (verificationPending()) outcome = 'verification';
      if (protection) {
        outcome = protection.denied ? 'blocked' : 'verification';
        if (
          protection.denied ||
          protection.interactive ||
          ['amazon', 'google'].includes(protection.provider) ||
          /prove your humanity|verify (?:that )?you are human|complete the challenge|enter the characters/i.test(
            snapshot.renderedText,
          )
        )
          break;
      } else if (outcome === 'ready') break;
    } catch (error) {
      if (
        !/Execution context was destroyed|navigating/i.test(String(error))
      )
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
    documentReadyState,
  };
};
