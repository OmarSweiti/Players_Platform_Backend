import { describe, expect, it } from 'vitest';
import { createIsolatedSchema, prismaFor } from '../harness/db';
import { asTenant, createTenant } from '../harness/fixtures';

describe('isolated test schemas', () => {
  it('two_harness_runs_never_share_a_schema', async () => {
    const [first, second] = await Promise.all([
      createIsolatedSchema(),
      createIsolatedSchema(),
    ]);
    const a = prismaFor(first.url);
    const b = prismaFor(second.url);
    try {
      expect(first.schema).not.toBe(second.schema);

      // Each counts as the tenant, so only the schema can hide the row.
      const tenant = await createTenant({ prisma: a.prisma });
      const count = (prisma: typeof a.prisma) =>
        asTenant(
          tenant.id,
          (tx) => tx.tenant.count({ where: { id: tenant.id } }),
          prisma,
        );
      await expect(count(a.prisma)).resolves.toBe(1);
      await expect(count(b.prisma)).resolves.toBe(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await Promise.all([first.drop(), second.drop()]);
    }
  });
});
