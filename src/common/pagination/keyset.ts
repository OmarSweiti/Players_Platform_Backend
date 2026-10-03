import type { Keyset } from './cursor';

/** The order every page is read in: newest first, the id breaking ties. */
export const KEYSET_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/**
 * A Prisma `where` for the rows after `after` in KEYSET_ORDER: older, or as
 * old with a smaller id. Combine it with the endpoint's filters under AND.
 */
export function keysetWhere(after: Keyset | undefined) {
  return after
    ? {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }
    : {};
}
