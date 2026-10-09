// domain/connection/url-guard is the SSRF guard for user-supplied upstream
// URLs (apiBaseUrl, tokenUrl). Per docs/api-contract.md a URL must:
//   - use https:,
//   - have a host that ends with one of the allowed suffixes,
//   - not be an IP literal or localhost.
// Additionally rejected (defence in depth): embedded credentials, explicit
// non-443 ports, query strings and fragments.

import { isIP } from 'node:net';

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function checkUpstreamUrl(
  raw: string,
  allowedSuffixes: readonly string[],
): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'must use https' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'must not contain credentials' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, reason: 'must use the default https port' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'must not contain a query string or fragment' };
  }
  // WHATWG URL normalises hostnames: lower-case, IPv4 shorthand/decimal
  // forms become dotted quads, IPv6 is bracketed.
  const host = url.hostname.replace(/\.$/, '');
  const bare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) {
    return { ok: false, reason: 'must not use an IP address' };
  }
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    return { ok: false, reason: 'must not point to localhost' };
  }
  const allowed = allowedSuffixes.some((suffix) => {
    const s = suffix.toLowerCase();
    return bare.endsWith(s) && bare.length > s.length;
  });
  if (!allowed) {
    return {
      ok: false,
      reason: `host must end with one of ${allowedSuffixes.join(', ')}`,
    };
  }
  // Normalise: no trailing slash so paths can be appended safely.
  const normalised = `${url.protocol}//${host}${url.pathname.replace(/\/+$/, '')}`;
  return { ok: true, url: normalised };
}
