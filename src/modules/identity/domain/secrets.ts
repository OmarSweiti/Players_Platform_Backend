import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// The random values sign-in hands out (0.5.5): the state, the nonce, the PKCE
// verifier, and the values of the pre-auth and session cookies. Each is 256
// random bits, written base64url; only a digest of a cookie's value is kept.

const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** 256 random bits, base64url: 43 characters. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Whether `value` has the shape newSecret gives: a cookie may hold anything. */
export function isSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET.test(value);
}

/** SHA-256 of `value`. */
export function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** The PKCE challenge for a verifier: BASE64URL(SHA-256(verifier)) (RFC 7636, S256). */
export function challengeOf(verifier: string): string {
  return digestOf(verifier).toString('base64url');
}

/** Whether two digests are equal, compared in constant time. */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
