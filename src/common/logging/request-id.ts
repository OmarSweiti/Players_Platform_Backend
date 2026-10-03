import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const ids = new WeakMap<Request, string>();

/**
 * Gives every request an id and returns it in `X-Request-Id`. It runs first
 * (app.setup.ts), so every response carries one — an error from any later
 * layer included — and a problem's `requestId` equals the header. 0.10.1
 * keeps a well-formed incoming id and hands the id to the structured logs.
 */
export function assignRequestId(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const id = randomUUID();
  ids.set(request, id);
  response.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/** The id `assignRequestId` gave this request. */
export function requestIdOf(request: Request): string | undefined {
  return ids.get(request);
}
