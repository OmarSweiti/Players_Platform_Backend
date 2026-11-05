import { describe, expect, it } from 'vitest';
import { isReturnPath, MAX_RETURN_PATH, returnUrl } from './return-path';

describe('the path sign-in returns to', () => {
  it('a_return_path_stays_on_this_origin', () => {
    for (const path of [
      '/',
      '/ar/players',
      '/en/contracts/0f6c6c55-6a7e-4c3b-9d0f-1b9a1f4c2b11?tab=versions#v2',
      '/ar/%D8%A7%D9%84%D9%84%D8%A7%D8%B9%D8%A8%D9%88%D9%86',
      '/%2F%2Felsewhere.test', // an encoded slash is a path segment here
    ]) {
      expect([path, isReturnPath(path)]).toEqual([path, true]);
    }
    for (const path of [
      '',
      'https://elsewhere.test/',
      'HTTPS://elsewhere.test',
      '//elsewhere.test',
      '///elsewhere.test',
      '/\\elsewhere.test',
      '\\\\elsewhere.test',
      '/.//elsewhere.test', // resolves to the path //elsewhere.test
      'javascript:alert(1)',
      'ar/players', // relative to wherever the callback is
      '/ar/players\r\nSet-Cookie: x=y',
      '/ar/\tplayers',
      '/ar/ players',
      '/ar/ players',
      `/${'a'.repeat(MAX_RETURN_PATH)}`,
    ]) {
      expect([path, isReturnPath(path)]).toEqual([path, false]);
    }
  });

  it('a_return_url_is_the_path_on_the_hosts_origin', () => {
    expect(returnUrl('https://sadara.localhost', '/ar/players?tab=1#top')).toBe(
      'https://sadara.localhost/ar/players?tab=1#top',
    );
    expect(() =>
      returnUrl('https://sadara.localhost', '//elsewhere.test'),
    ).toThrow(RangeError);
  });
});
