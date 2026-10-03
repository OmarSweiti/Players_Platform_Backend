import type { Request } from 'express';

/**
 * The route template (`/api/players/:id`), never the URL: a query string
 * carries tokens and search terms.
 */
export function routeTemplateOf(request: Request): string {
  const path: unknown = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path : '(unmatched route)';
}

/**
 * The request's full path without its query or fragment — `/api/players/7`,
 * never `?token=…` — as the client sent it, the way NestJS 12 reads it. Not
 * `request.path`: that is relative to where the handler is mounted, and
 * NestJS 12 mounts its not-found handler under the global prefix. A target
 * in absolute form (`http://host/…`) loses its scheme and authority, so no
 * userinfo is ever echoed.
 */
export function requestPathOf(request: Request): string {
  const [target] = request.originalUrl.split(/[?#]/, 1);
  return target.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '') || '/';
}
