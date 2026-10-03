import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../errors/domain-error';

/** A cursor that does not belong to this query, or is not a cursor at all. */
export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
}

/** Where a page ended: the last row's sort key, `(createdAt, id)`. */
export interface Keyset {
  createdAt: Date;
  id: string;
}

/**
 * What a cursor is bound to: the caller's tenant, the filters and the sort.
 * Computed from trusted request state on every use, never read from the
 * cursor, so a cursor from another query — another tenant, other filters,
 * another sort — is refused, and a cursor never grants anything.
 */
export interface CursorScope {
  tenantId: string;
  filters: Readonly<Record<string, unknown>>;
  sort: string;
}

const Cursor = z.strictObject({
  v: z.literal(1), // the cursor format's version
  t: z.iso.datetime(),
  i: z.uuid(),
  f: z.string().length(43), // the scope's fingerprint
});

/** The scope's fingerprint: SHA-256 over its canonical JSON, base64url. */
export function fingerprintOf(scope: CursorScope): string {
  return createHash('sha256').update(canonical(scope)).digest('base64url');
}

/** JSON with object keys sorted, so equal scopes hash equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** An opaque cursor for the page after `last`, within `scope`. */
export function encodeCursor(last: Keyset, scope: CursorScope): string {
  const cursor: z.infer<typeof Cursor> = {
    v: 1,
    t: last.createdAt.toISOString(),
    i: last.id,
    f: fingerprintOf(scope),
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Where the previous page ended, if `cursor` belongs to this scope. */
export function decodeCursor(cursor: string, scope: CursorScope): Keyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('The cursor is not one this API issued');
  }
  const result = Cursor.safeParse(parsed);
  if (!result.success || result.data.f !== fingerprintOf(scope)) {
    throw new InvalidCursorError('The cursor belongs to another query');
  }
  return { createdAt: new Date(result.data.t), id: result.data.i };
}
