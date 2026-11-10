import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../errors/domain-error';
import {
  CANONICAL_PATH_MAX,
  idempotentRequestOf,
  IdempotentRouteRefused,
} from './idempotent-request';
import { canonicalOf, keyHashOf, requestHashOf } from './request-hash';

const ID = '6f1c2a9e-4b7d-4c1e-9a3f-2d5e8b7c6a10';

/** A request as Express hands it to a route: its route's template and parameters. */
function requestOf(
  headers: Record<string, string>,
  {
    method = 'PATCH',
    template = '/api/v1/players/:id',
    params = { id: ID },
  }: {
    method?: string;
    template?: string;
    params?: Record<string, string>;
  } = {},
): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    method,
    route: { path: template },
    params,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

describe('an idempotent request', () => {
  it('is its key, its method, its route with parameters, and its If-Match', () => {
    expect(
      idempotentRequestOf(
        requestOf({ 'Idempotency-Key': 'k-1', 'If-Match': '"tag"' }),
      ),
    ).toEqual({
      key: 'k-1',
      method: 'PATCH',
      canonicalPath: `/api/v1/players/${ID}`,
      ifMatch: '"tag"',
    });
    // A parameter is encoded: the path stays printable ASCII, one form.
    expect(
      idempotentRequestOf(
        requestOf(
          { 'Idempotency-Key': 'k' },
          {
            method: 'POST',
            template: '/api/v1/tags/:name',
            params: { name: 'a b/é' },
          },
        ),
      ).canonicalPath,
    ).toBe('/api/v1/tags/a%20b%2F%C3%A9');
  });

  it('takes a key of 1 to 128 printable characters, and nothing else', () => {
    for (const key of [
      'a',
      '~'.repeat(128),
      '8e03978e-40d5-43e8-bc93-6894a57f9324',
      '"quoted"',
    ]) {
      expect(
        idempotentRequestOf(requestOf({ 'Idempotency-Key': key })).key,
      ).toBe(key);
    }
    for (const headers of [
      {},
      { 'Idempotency-Key': '' },
      { 'Idempotency-Key': 'x'.repeat(129) },
      { 'Idempotency-Key': 'two words' },
      { 'Idempotency-Key': 'tab\tkey' },
      { 'Idempotency-Key': 'clé' },
    ] as Record<string, string>[]) {
      expect(() => idempotentRequestOf(requestOf(headers))).toThrow(
        ValidationFailedError,
      );
    }
  });

  it('refuses a path longer than a record keeps', () => {
    const long = 'p'.repeat(CANONICAL_PATH_MAX);
    expect(() =>
      idempotentRequestOf(
        requestOf({ 'Idempotency-Key': 'k' }, { params: { id: long } }),
      ),
    ).toThrow(ValidationFailedError);
  });

  it('cannot be a read, or a route with no one canonical form', () => {
    for (const [method, template] of [
      ['GET', '/api/v1/players/:id'],
      ['PATCH', '/api/v1/files/*path'],
      ['PATCH', '/api/v1/players{/:id}'],
    ]) {
      expect(() =>
        idempotentRequestOf(
          requestOf({ 'Idempotency-Key': 'k' }, { method, template }),
        ),
      ).toThrow(IdempotentRouteRefused);
    }
  });
});

describe('the hashes a record keeps', () => {
  it('orders every object’s keys, at every depth, and drops what JSON drops', () => {
    expect(
      JSON.stringify(
        canonicalOf({
          b: [{ z: 1, a: 2 }],
          a: { y: null, x: undefined, at: new Date('2026-11-10T00:00:00Z') },
        }),
      ),
    ).toBe(
      '{"a":{"at":"2026-11-10T00:00:00.000Z","y":null},"b":[{"a":2,"z":1}]}',
    );
  });

  it('hashes the same request alike, and any other differently', () => {
    const hash = requestHashOf({ ifMatch: '"r1"' }, { name: 'A', age: 20 });
    expect(hash).toHaveLength(32);
    expect(requestHashOf({ ifMatch: '"r1"' }, { age: 20, name: 'A' })).toEqual(
      hash,
    );
    for (const other of [
      requestHashOf({ ifMatch: '"r2"' }, { name: 'A', age: 20 }),
      requestHashOf({}, { name: 'A', age: 20 }),
      requestHashOf({ ifMatch: '"r1"' }, { name: 'B', age: 20 }),
      requestHashOf({ ifMatch: '"r1"' }, { name: 'A', age: '20' }),
    ]) {
      expect(other).not.toEqual(hash);
    }
    expect(keyHashOf('k-1')).toHaveLength(32);
    expect(keyHashOf('k-1')).not.toEqual(keyHashOf('k-2'));
  });
});
