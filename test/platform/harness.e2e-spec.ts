import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createTenant, runPrisma } from '../harness/fixtures';

describe('the API test harness', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp();
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  it('harness_boots_against_an_isolated_schema', async () => {
    const schema = inject('databaseSchema');
    expect(schema).toMatch(/^sadara_test_[0-9a-f]{12}$/);

    // The whole HTTP pipeline answers.
    await booted.http.get('/api/health').expect(200);

    // A fixture written to the run's schema is what the app itself reads.
    const tenant = await createTenant();
    const member = await createMember(tenant, 'COACH');
    const prisma = booted.app.get(PrismaService);
    await expect(
      prisma.user.findUnique({ where: { id: member.id } }),
    ).resolves.toMatchObject({
      tenantId: tenant.id,
    });

    // The migrated tables live in that schema.
    const tables = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name IN ('tenants', 'users')`;
    expect(Number(tables[0].count)).toBe(2);
  });

  it('raw_sql_runs_in_the_run_schema', async () => {
    // Prisma names the schema in its own queries; raw SQL has only the
    // connection's search_path, which must be the same schema.
    const schema = inject('databaseSchema');
    for (const prisma of [booted.app.get(PrismaService), runPrisma()]) {
      const [row] = await prisma.$queryRaw<{ schema: string }[]>`
        SELECT current_schema() AS schema`;
      expect(row.schema).toBe(schema);
    }
  });
});
