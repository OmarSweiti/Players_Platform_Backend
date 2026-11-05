import type { Response } from 'supertest';

/** A cookie as the API set it: its value and its attributes, in lower case. */
export interface SetCookie {
  value: string;
  attributes: Record<string, string>;
}

/** The cookies a response sets or clears, by name. */
export function setCookiesOf(response: Response): Map<string, SetCookie> {
  const headers = response.headers['set-cookie'] as unknown as
    string[] | undefined;
  const cookies = new Map<string, SetCookie>();
  for (const header of headers ?? []) {
    const [pair, ...rest] = header.split(';').map((part) => part.trim());
    const at = pair.indexOf('=');
    cookies.set(pair.slice(0, at), {
      value: pair.slice(at + 1),
      attributes: Object.fromEntries(
        rest.map((attribute) => {
          const [name, value = ''] = attribute.split('=');
          return [name.toLowerCase(), value];
        }),
      ),
    });
  }
  return cookies;
}
