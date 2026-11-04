import { describe, expect, it } from 'vitest';
import { hostOf } from './tenant-resolver';

// The host a request names (0.5.2), as Express hands it over in
// `request.hostname` — the port already gone, a forwarded host already
// believed or not by TRUSTED_PROXIES.
const host = (hostname: string | undefined) =>
  hostOf({ hostname } as { hostname: string });

describe('the host of a request', () => {
  it('is the host name in lower case, without a trailing dot', () => {
    expect(host('sadara.localhost')).toBe('sadara.localhost');
    expect(host('Sadara.LOCALHOST')).toBe('sadara.localhost');
    expect(host('agency.test.')).toBe('agency.test');
    expect(host('xn--mgbe0ffr.test')).toBe('xn--mgbe0ffr.test');
  });

  it('is none when the request names no host name', () => {
    for (const hostname of [
      undefined,
      '',
      '[::1]',
      'agency_one.test',
      '-agency.test',
      'وكالة.test',
      `${'a'.repeat(64)}.test`,
    ]) {
      expect([hostname, host(hostname)]).toEqual([hostname, null]);
    }
  });
});
