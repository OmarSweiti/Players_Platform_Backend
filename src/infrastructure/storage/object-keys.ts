import { randomUUID } from 'node:crypto';
import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';

/**
 * Where an object lives (ADR-0009): an upload lands in `quarantine`, and only a
 * clean file is promoted to `objects`, by a server-side copy (0.8.4).
 */
export type ObjectArea = 'quarantine' | 'objects';

declare const built: unique symbol;

/** A key only `newObjectKey` or `objectKeyOf` makes: a string from elsewhere is not one. */
export type ObjectKey = string & { readonly [built]: true };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_V4 =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const KEY = new RegExp(`^tenants/(${UUID})/(quarantine|objects)/(${UUID_V4})$`);

/** A key that is not one the builder made, or not this tenant's: a programming error. */
export class ObjectKeyRefused extends Error {
  constructor(reason: string) {
    super(`object key refused: ${reason}`);
    this.name = 'ObjectKeyRefused';
  }
}

/**
 * A new key for an object of the context's tenant (0.8.1; ADR-0009):
 * `tenants/{tenantId}/{area}/{uuid}`. Random and opaque — never a file's
 * name, never a path a caller chose — and prefixed by the tenant the context
 * was authorized for, which no request supplies.
 */
export function newObjectKey(
  ctx: AuthorizedTenantContext,
  area: ObjectArea,
): ObjectKey {
  return `tenants/${ctx.tenantId}/${area}/${randomUUID()}` as ObjectKey;
}

/**
 * A key read back — from the database, say — as an `ObjectKey`: one the
 * builder made, in the area expected, of the context's own tenant. Anything
 * else is refused.
 */
export function objectKeyOf(
  ctx: AuthorizedTenantContext,
  value: string,
  area: ObjectArea,
): ObjectKey {
  const parts = KEY.exec(value);
  if (parts === null) throw new ObjectKeyRefused('not a key the builder made');
  if (parts[1] !== ctx.tenantId) {
    throw new ObjectKeyRefused('another tenant’s key');
  }
  if (parts[2] !== area) throw new ObjectKeyRefused(`not in ${area}`);
  return value as ObjectKey;
}

/** Throws unless `key` has the builder's form: what every storage call checks first. */
export function assertObjectKey(key: string): asserts key is ObjectKey {
  if (!KEY.test(key)) throw new ObjectKeyRefused('not a key the builder made');
}
