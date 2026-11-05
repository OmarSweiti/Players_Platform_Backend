/** The longest path sign-in returns the browser to. */
export const MAX_RETURN_PATH = 2048;

const SOMEWHERE = 'https://return-path.invalid';

/**
 * Whether the browser may be sent to `value` once signed in (0.5.5): a path on
 * this origin and nothing else. It begins with exactly one `/`, holds no
 * backslash, white space or control character, and still names this origin
 * once resolved, with no path that begins `//`. Anything that could reach
 * another origin — `//host`, `/\host`, a scheme, `/.//host` — is refused, so
 * sign-in can never become an open redirect.
 */
export function isReturnPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RETURN_PATH) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (/[\\\s\p{Cc}]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value, SOMEWHERE);
  } catch {
    return false;
  }
  return url.origin === SOMEWHERE && !url.pathname.startsWith('//');
}

/** The address of a return path on `origin`, which is where it stays. */
export function returnUrl(origin: string, path: string): string {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin || !isReturnPath(path)) {
    throw new RangeError('not a return path on this origin');
  }
  return url.href;
}
