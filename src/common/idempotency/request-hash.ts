import { createHash } from 'node:crypto';
import type { IdempotentRequest } from './idempotent-request';

/** SHA-256 of `text`: what the idempotency record keeps instead of it. */
function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

/**
 * `value` with every object's keys in order, recursively, and every value as
 * JSON gives it (a date's `toJSON`, a decimal's): two requests that mean the
 * same thing have the same form, however their keys were ordered.
 */
export function canonicalOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    return canonicalOf((json as () => unknown).call(value));
  }
  if (Array.isArray(value)) return value.map(canonicalOf);
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, canonicalOf(object[key])]),
  );
}

/** The hash of a client's key: the key itself is never kept. */
export function keyHashOf(key: string): Buffer {
  return sha256(key);
}

/**
 * The hash of a request (docs/reference/api.md, "Idempotency state
 * machine"): its validated input and its precondition, the `If-Match` it was
 * sent with. The method and path are the key's namespace, not part of the
 * hash. A retry must send the same input and the same `If-Match` — the stale
 * one, after the first success: it is still the same request.
 */
export function requestHashOf(
  request: Pick<IdempotentRequest, 'ifMatch'>,
  input: unknown,
): Buffer {
  return sha256(
    JSON.stringify(
      canonicalOf({ input: input ?? null, ifMatch: request.ifMatch ?? null }),
    ),
  );
}
