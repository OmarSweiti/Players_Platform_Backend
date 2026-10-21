import type { NextFunction, Request, Response } from 'express';
import {
  isRequestId,
  newRequestId,
  runWithRequestId,
} from '../../infrastructure/logging/correlation';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const ids = new WeakMap<Request, string>();

/**
 * Gives every request an id and returns it in `X-Request-Id`. It runs first
 * (app.setup.ts), so every response carries one — an error from any later
 * layer included — and a problem's `requestId` equals the header. The id is
 * the one a trusted proxy assigned, or a new UUIDv7. The access log takes it
 * over (infrastructure/logging), and the rest of the request runs inside it,
 * so the jobs it enqueues carry it on.
 */
export function assignRequestId(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const id = upstreamRequestIdOf(request) ?? newRequestId();
  ids.set(request, id);
  response.setHeader(REQUEST_ID_HEADER, id);
  runWithRequestId(id, next);
}

/** The id `assignRequestId` gave this request. */
export function requestIdOf(request: Request): string | undefined {
  return ids.get(request);
}

/**
 * The id a proxy assigned upstream, as X-Forwarded-For is believed (0.3.8):
 * only from a peer TRUSTED_PROXIES names, and only when it is a well-formed
 * UUID. A client never chooses the id its requests are logged under.
 */
function upstreamRequestIdOf(request: Request): string | undefined {
  const id = request.headers[REQUEST_ID_HEADER.toLowerCase()];
  if (!isRequestId(id)) return undefined;
  const trusted = request.app.get('trust proxy fn') as (
    address: string,
    hop: number,
  ) => boolean;
  const peer = request.socket.remoteAddress;
  return peer !== undefined && trusted(peer, 0) ? id.toLowerCase() : undefined;
}
