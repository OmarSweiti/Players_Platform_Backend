import { z } from 'zod';

// The building blocks of request schemas: one validation mechanism, Zod 4
// through NestJS's Standard Schema pipe (ADR-0024; docs/reference/api.md,
// "Route and request rules"). Bodies, queries and path parameters are strict
// objects, so a property the schema does not name is refused; strings and
// arrays are bounded; a query is coerced explicitly, field by field.

/** An entity id. */
export const id = z.uuid();

/** The path parameters of `/…/:id`. */
export const IdParams = z.strictObject({ id });
export type IdParams = z.infer<typeof IdParams>;

/** The path parameters of `/…/player/:playerId`. */
export const PlayerIdParams = z.strictObject({ playerId: id });
export type PlayerIdParams = z.infer<typeof PlayerIdParams>;

/** One line a person typed — a name, a type, a region: trimmed, never empty. */
export const line = (max: number) => z.string().trim().min(1).max(max);

/** Prose a person wrote — notes, a description: bounded, its whitespace kept. */
export const prose = (max = 10_000) => z.string().max(max);

/** A calendar day: `2026-10-03`. */
export const day = z.iso.date();

/** An instant, with its offset: `2026-10-03T14:00:00+03:00`. */
export const instant = z.iso.datetime({ offset: true });

/** A query bound that may be a day or an instant. */
export const dayOrInstant = z.union([day, instant]);

/** A query flag: exactly `true` or `false`, never any other truthy string. */
export const flag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** A page of a list, until cursor pagination replaces it (0.3.5). */
export const paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

/**
 * A PATCH body: any of its fields, and at least one of them — an empty
 * change is refused, as TOO_SMALL on the whole body.
 */
export function nonEmpty<T extends z.ZodType<object>>(schema: T): T {
  return schema.refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    { params: { code: 'TOO_SMALL' } },
  );
}
