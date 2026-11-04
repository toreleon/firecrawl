import { isIP } from 'node:net';
import { getDomain } from 'tldts';

export const cookieScope = (
  url: string,
): { domain: string; path: string } | { url: string } => {
  const host = new URL(url).hostname;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return { url };
  const domain = getDomain(host, { allowPrivateDomains: true });
  return domain ? { domain: `.${domain}`, path: '/' } : { url };
};
