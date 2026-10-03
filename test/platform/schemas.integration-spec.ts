import { describe, expect, it } from 'vitest';
import { createIsolatedSchema, prismaFor } from '../harness/db';
import { createTenant } from '../harness/fixtures';

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

      const tenant = await createTenant({ prisma: a.prisma });
      await expect(
        a.prisma.tenant.count({ where: { id: tenant.id } }),
      ).resolves.toBe(1);
      await expect(
        b.prisma.tenant.count({ where: { id: tenant.id } }),
      ).resolves.toBe(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await Promise.all([first.drop(), second.drop()]);
    }
  });
});
