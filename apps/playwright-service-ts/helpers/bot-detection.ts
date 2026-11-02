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
