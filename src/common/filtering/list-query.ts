import { z } from 'zod';

/** The one order lists support today (keyset.ts); others come with a tiebreaker. */
export const NEWEST_FIRST = 'createdAt:desc';

/**
 * The query of a list endpoint: the filters it allowlists, its sort, and a
 * page — a strict object, so an unlisted filter is refused, never ignored.
 * `limit` defaults to 25; above 100 is a 400, never a silent cap.
 */
export function listQuery<Filters extends z.ZodRawShape>(filters: Filters) {
  return z.strictObject({
    ...filters,
    sort: z.literal(NEWEST_FIRST).default(NEWEST_FIRST),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  });
}

/** The filters of a parsed list query: what its cursor is bound to. */
export function filtersOf(
  query: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(
      ([key]) => key !== 'sort' && key !== 'limit' && key !== 'cursor',
    ),
  );
}

/** A search term: trimmed, at least 1 and at most `max` characters. */
export const search = (max = 100) => z.string().trim().min(1).max(max);

/** One or more of `values`, as a repeated query parameter: `?status=A&status=B`. */
export function anyOf<const T extends readonly [string, ...string[]]>(
  values: T,
) {
  const one = z.enum(values);
  return z
    .union([one, z.array(one).min(1).max(values.length)])
    .transform((value) => (Array.isArray(value) ? value : [value]));
}
