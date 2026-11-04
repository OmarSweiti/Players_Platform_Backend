import { describe, expect, it } from 'vitest';
import { NEWEST_FIRST } from '../../src/common/filtering/list-query';
import { KEYSET_ORDER, keysetWhere } from '../../src/common/pagination/keyset';
import {
  type KeysetArgs,
  paginate,
} from '../../src/common/pagination/paginate';
import type { TenantTx } from '../../src/common/tenancy/tenant-transaction';
import { asTenant, createPlayer, createTenant } from '../harness/fixtures';

describe('keyset pagination on PostgreSQL', () => {
  it('pages_a_real_table_without_skips_or_repeats', async () => {
    const tenant = await createTenant();
    await createPlayer(await createTenant()); // another tenant's row
    // Each read and write is its own transaction, as the tenant.
    const db = <T>(work: (tx: TenantTx) => Promise<T>) =>
      asTenant(tenant.id, work);

    // Eight players; three created in the same millisecond, so only the
    // id orders them.
    const base = Date.UTC(2026, 9, 3, 12);
    for (const [i, second] of [0, 1, 1, 1, 2, 3, 4, 5].entries()) {
      await db((tx) =>
        tx.player.create({
          data: {
            tenantId: tenant.id,
            fullName: `Paged player ${i}`,
            createdAt: new Date(base + second * 1000),
          },
        }),
      );
    }
    const select = { id: true, createdAt: true } as const;
    const expected = await db((tx) =>
      tx.player.findMany({
        where: { tenantId: tenant.id },
        orderBy: [...KEYSET_ORDER],
        select,
      }),
    );

    const fetch = ({ take, after }: KeysetArgs) =>
      db((tx) =>
        tx.player.findMany({
          where: { AND: [{ tenantId: tenant.id }, keysetWhere(after)] },
          orderBy: [...KEYSET_ORDER],
          take,
          select,
        }),
      );
    const scope = { tenantId: tenant.id, filters: {}, sort: NEWEST_FIRST };

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const { data, page } = await paginate({ limit: 3, cursor, scope }, fetch);
      seen.push(...data.map(({ id }) => id));
      cursor = page.nextCursor ?? undefined;
      // A newer player between pages never shifts a later page.
      await db((tx) =>
        tx.player.create({
          data: {
            tenantId: tenant.id,
            fullName: 'Late arrival',
            createdAt: new Date(base + 3_600_000),
          },
        }),
      );
    } while (cursor);

    expect(seen).toEqual(expected.map(({ id }) => id));
  });
});
