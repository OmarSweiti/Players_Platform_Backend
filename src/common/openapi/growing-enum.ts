import type { z } from 'zod';

const growing = new WeakSet<z.ZodType>();

/**
 * An enum whose values grow by design — the permission catalog, say: the
 * contract lists its values as `x-extensible-enum`, not `enum`, so a value
 * added later breaks no client, and a client must accept one it does not know
 * (ADR-0010; docs/reference/api.md, "OpenAPI and compatibility"). Only the
 * contract changes: the schema still validates against these values alone.
 */
export function growingEnum<T extends z.ZodType>(schema: T): T {
  growing.add(schema);
  return schema;
}

/**
 * `z.toJSONSchema`'s override (zod-schema-converter.ts): a growing enum's
 * `enum` becomes `x-extensible-enum`, its values and their order kept.
 */
export function describeGrowingEnums(ctx: {
  readonly zodSchema: unknown;
  readonly jsonSchema: Record<string, unknown>;
}): void {
  if (!growing.has(ctx.zodSchema as z.ZodType)) return;
  const { jsonSchema } = ctx;
  if (!Array.isArray(jsonSchema.enum)) return;
  jsonSchema['x-extensible-enum'] = jsonSchema.enum;
  delete jsonSchema.enum;
}
