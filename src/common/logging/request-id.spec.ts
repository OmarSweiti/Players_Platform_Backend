import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { currentRequestId } from '../../infrastructure/logging/correlation';
import { assignRequestId, REQUEST_ID_HEADER, requestIdOf } from './request-id';

const UPSTREAM = '0192F3A4-5B6C-7D8E-9FA0-B1C2D3E4F5A6'; // a UUIDv7, upper case
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROXY = '10.0.0.2';
const CLIENT = '203.0.113.9';

/** A request from `peer`, to an app whose TRUSTED_PROXIES is PROXY alone. */
function requestFrom(peer: string, header?: string): Request {
  const trusted = (address: string) => address === PROXY;
  return {
    headers: header === undefined ? {} : { 'x-request-id': header },
    socket: { remoteAddress: peer },
    app: {
      get: (setting: string) =>
        setting === 'trust proxy fn' ? trusted : undefined,
    },
  } as unknown as Request;
}

/** Runs the middleware: the id it kept, the header it set, the id `next` ran in. */
function assign(request: Request) {
  const headers = new Map<string, unknown>();
  const response = {
    setHeader: (name: string, value: unknown) => headers.set(name, value),
  } as unknown as Response;
  let runningIn: string | undefined;
  const next = (() => {
    runningIn = currentRequestId();
  }) as NextFunction;
  assignRequestId(request, response, next);
  return {
    id: requestIdOf(request),
    header: headers.get(REQUEST_ID_HEADER),
    runningIn,
  };
}

describe('assignRequestId', () => {
  it('gives a request a new UUIDv7: in the header, and as the id the rest of the request runs in', () => {
    const { id, header, runningIn } = assign(requestFrom(CLIENT));
    expect(id).toMatch(UUID_V7);
    expect(header).toBe(id);
    expect(runningIn).toBe(id);
  });

  it('gives every request its own id', () => {
    expect(assign(requestFrom(CLIENT)).id).not.toBe(
      assign(requestFrom(CLIENT)).id,
    );
  });

  it('keeps the well-formed id a trusted proxy assigned, in lower case', () => {
    const { id, header } = assign(requestFrom(PROXY, UPSTREAM));
    expect(id).toBe(UPSTREAM.toLowerCase());
    expect(header).toBe(id);
  });

  it('never lets a client choose the id its requests are logged under', () => {
    const { id } = assign(requestFrom(CLIENT, UPSTREAM));
    expect(id).not.toBe(UPSTREAM.toLowerCase());
    expect(id).toMatch(UUID_V7);
  });

  it('replaces an id that is not a canonical UUID, even from a trusted proxy', () => {
    for (const header of [
      'req-42',
      `${UPSTREAM}, ${UPSTREAM}`, // the header twice
      ` ${UPSTREAM}`,
      `${UPSTREAM}\n{"level":"info"}`,
      '00000000-0000-0000-0000-000000000000', // nil
      'ffffffff-ffff-ffff-ffff-ffffffffffff', // max
    ]) {
      expect(assign(requestFrom(PROXY, header)).id).toMatch(UUID_V7);
    }
  });
});
