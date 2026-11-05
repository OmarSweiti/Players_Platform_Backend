import type { CookieOptions } from 'express';

// The browser's two cookies (ADR-0003, ADR-0023). Both are set by the API over
// HTTPS and read only by it: `__Host-` keeps them on this exact host, with
// `Path=/` and no `Domain`; `Http` in the prefix makes the browser refuse one
// that a script tries to set (RFC 10017). Neither is ever logged.

/** The opaque session sign-in issues (0.5.5); 0.5.6 makes it authenticate requests. */
export const SESSION_COOKIE = '__Host-Http-sadara_session';

/**
 * Binds a sign-in to the browser that started it (0.5.5): it completes a
 * sign-in and grants nothing else, and the callback clears it.
 */
export const PREAUTH_COOKIE = '__Host-Http-sadara_preauth';

/** The attributes both cookies carry, and are cleared with. */
export const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  // Lax, not Strict, so that a link from an email arrives signed in; every
  // write needs more than the cookie (ADR-0023).
  sameSite: 'lax',
  path: '/',
} as const satisfies CookieOptions;
