import type { Request } from 'express';

/**
 * The route template (`/api/players/:id`), never the URL: a query string
 * carries tokens and search terms. A request no route took is unmatched —
 * also when a wildcard answered it, as Nest's not-found catch-all under the
 * API prefix (`*path`) or the body parsers' mount (`/api{/*splat}`, which
 * refuses a body before any route takes the request): no route of ours has a
 * wildcard.
 */
export function routeTemplateOf(request: Request): string {
  const path: unknown = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' && path.startsWith('/') && !path.includes('*')
    ? path
    : '(unmatched route)';
}
