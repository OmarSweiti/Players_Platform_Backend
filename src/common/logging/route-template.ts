import type { Request } from 'express';

/**
 * The route template (`/api/players/:id`), never the URL: a query string
 * carries tokens and search terms. A request no route took is unmatched —
 * also when Nest answers it from the catch-all it mounts under the API
 * prefix, whose template (`*path`) names no route of ours.
 */
export function routeTemplateOf(request: Request): string {
  const path: unknown = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' && path.startsWith('/')
    ? path
    : '(unmatched route)';
}
