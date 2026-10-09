import { describe, expect, it } from 'vitest';

import { DEFAULT_ALLOWED_HOST_SUFFIXES } from '../../config.js';

import { checkUpstreamUrl } from './url-guard.js';

const check = (u: string) => checkUpstreamUrl(u, DEFAULT_ALLOWED_HOST_SUFFIXES);

describe('SSRF guard', () => {
  it.each([
    'https://gateway.eu1.mindsphere.io/api/assetmanagement/v3',
    'https://api.eu1.siemens.app/assetmanagement-1000001700/v3/',
    'https://acme.piam.eu1.mindsphere.io/oauth/token',
    'https://gateway.cn1.mindsphere-in.cn/api/assetmanagement/v3',
    'https://GATEWAY.EU1.MINDSPHERE.IO:443/api',
  ])('accepts %s', (u) => {
    const res = check(u);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url.endsWith('/')).toBe(false);
  });

  it.each([
    ['http://gateway.eu1.mindsphere.io/api', 'https'],
    ['https://127.0.0.1/api', 'IP'],
    ['https://[::1]/api', 'IP'],
    ['https://2130706433/api', 'IP'],
    ['https://localhost/api', 'localhost'],
    ['https://evil.localhost/api', 'localhost'],
    ['https://mindsphere.io.evil.com/api', 'host must end'],
    ['https://evilmindsphere.io/api', 'host must end'],
    ['https://user:pw@gateway.eu1.mindsphere.io/api', 'credentials'],
    ['https://gateway.eu1.mindsphere.io:8443/api', 'port'],
    ['https://gateway.eu1.mindsphere.io/api?x=1', 'query'],
    ['not a url', 'valid URL'],
  ])('rejects %s', (u, reason) => {
    const res = check(u);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(reason);
  });

  it('honours a custom suffix list', () => {
    expect(
      checkUpstreamUrl('https://x.example.org/a', ['.example.org']).ok,
    ).toBe(true);
    expect(
      checkUpstreamUrl('https://gateway.eu1.mindsphere.io/a', ['.example.org'])
        .ok,
    ).toBe(false);
  });
});
