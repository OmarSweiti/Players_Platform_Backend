import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { requestPathOf, routeTemplateOf } from './route-template';

const requestTo = (originalUrl: string, extra: object = {}) =>
  ({ originalUrl, ...extra }) as unknown as Request;

describe('routeTemplateOf', () => {
  it('names the matched route, never the URL', () => {
    const request = requestTo('/api/players/7?token=secret', {
      route: { path: '/api/players/:id' },
    });
    expect(routeTemplateOf(request)).toBe('/api/players/:id');
  });

  it('names an unmatched route without its URL', () => {
    expect(routeTemplateOf(requestTo('/api/nope?token=secret'))).toBe(
      '(unmatched route)',
    );
  });
});

describe('requestPathOf', () => {
  it('keeps the global prefix, even where a handler is mounted under it', () => {
    // Inside NestJS 12's not-found handler, request.path is '/no-such-route'.
    const request = requestTo('/api/no-such-route', { path: '/no-such-route' });
    expect(requestPathOf(request)).toBe('/api/no-such-route');
  });

  it('drops the query and the fragment', () => {
    expect(requestPathOf(requestTo('/api/players?token=secret'))).toBe(
      '/api/players',
    );
    expect(requestPathOf(requestTo('/api/players#token=secret'))).toBe(
      '/api/players',
    );
  });

  it('keeps the path exactly as the client sent it', () => {
    expect(requestPathOf(requestTo('/api/a/../%7Eb'))).toBe('/api/a/../%7Eb');
    expect(requestPathOf(requestTo('//other.test/api'))).toBe(
      '//other.test/api',
    );
  });

  it('reduces an absolute-form target to its path, never its userinfo', () => {
    expect(
      requestPathOf(requestTo('http://user:secret@api.test/api/players?q=1')),
    ).toBe('/api/players');
    expect(requestPathOf(requestTo('http://api.test'))).toBe('/');
    expect(requestPathOf(requestTo('http://[::1/api/players'))).toBe(
      '/api/players',
    );
  });
});
