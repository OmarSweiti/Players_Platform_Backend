import type { Request } from 'express';

/**
 * The route template (`/api/players/:id`), never the URL: a query string
 * carries tokens and search terms.
 */
export function routeTemplateOf(request: Request): string {
  const path: unknown = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path : '(unmatched route)';
}
