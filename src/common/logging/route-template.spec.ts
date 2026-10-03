import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { routeTemplateOf } from './route-template';

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
