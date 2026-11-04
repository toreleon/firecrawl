export type BotDetection = { provider: string; reason: string };

/** Classify interstitials, not ordinary pages that embed a CAPTCHA widget. */
export const detectBotChallenge = (
  html: string,
  headers: Record<string, string> = {},
): BotDetection | undefined => {
  if (
    Object.entries(headers).some(
      ([key, value]) =>
        key.toLowerCase() === 'cf-mitigated' &&
        value.toLowerCase() === 'challenge',
    )
  ) {
    return {
      provider: 'cloudflare',
      reason: 'cf-mitigated challenge response',
    };
  }
  const title =
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
  // DataDome device-check/captcha documents often use the site's domain as
  // their title. A DataDome script on an ordinary page is not sufficient.
  if (
    html.length < 50000 &&
    /<script\b[^>]*>\s*(?:var|let|const)\s+dd\s*=\s*\{/i.test(html) &&
    /(?:geo|ct)\.captcha-delivery\.com\//i.test(html) &&
    /['"](?:cid|hsh|rt)['"]\s*:/i.test(html)
  )
    return {
      provider: 'datadome',
      reason: 'DataDome challenge bootstrap document',
    };

  const visibleText = html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  if (
    /<(?:div|iframe)\b[^>]*(?:id|class)=["'][^"']*px-captcha/i.test(html) &&
    /(?:are you a person or a robot|verify (?:that )?you are human|press (?:&amp;|&) hold)/i.test(
      visibleText,
    )
  )
    return {
      provider: 'perimeterx',
      reason: 'HUMAN/PerimeterX verification interstitial',
    };
  if (
    /^Reddit\s*[-–]\s*Prove your humanity$/i.test(title) &&
    /complete the challenge below/i.test(visibleText) &&
    /captcha/i.test(html)
  )
    return {
      provider: 'reddit',
      reason: 'Reddit human verification interstitial',
    };
  if (
    /^(just a moment\.{0,3}|attention required!?\s*\|\s*cloudflare)$/i.test(
      title,
    ) &&
    /(?:cf-chl-|\/cdn-cgi\/challenge-platform\/)/i.test(html)
  ) {
    return {
      provider: 'cloudflare',
      reason: 'Cloudflare challenge interstitial',
    };
  }
  if (
    /^(robot or human\??|pardon our interruption|access to this page has been denied\.?|verify you are human)$/i.test(
      title,
    ) &&
    /(?:captcha-delivery\.com|datadome|px-captcha|hcaptcha|g-recaptcha)/i.test(
      html,
    )
  ) {
    return { provider: 'captcha', reason: 'Human verification interstitial' };
  }
  return undefined;
};
