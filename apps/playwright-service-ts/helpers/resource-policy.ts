import { getDomain } from 'tldts';

const adServingDomains = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'amazon-adsystem.com',
];

export const shouldBlockAdRequest = (
  url: string,
  documentUrl: string,
  topLevelNavigation: boolean,
) => {
  // Requested documents and their own site resources must remain retrievable.
  // fbcdn.net is a content CDN serving Facebook's application, not an ad domain.
  if (topLevelNavigation) return false;
  const hostname = new URL(url).hostname.toLowerCase();
  if (
    !adServingDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
  )
    return false;
  try {
    const site = (host: string) =>
      getDomain(host, { allowPrivateDomains: true }) ?? host;
    if (site(hostname) === site(new URL(documentUrl).hostname)) return false;
  } catch {
    // A new frame can still be about:blank; third-party filtering remains on.
  }
  return true;
};
