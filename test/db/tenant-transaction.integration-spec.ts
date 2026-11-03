import { randomUUID } from 'node:crypto';
import { Prisma, type Tenant } from '@prisma/client';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import {
  mintTenantContext,
  TenantContextRefused,
  type TenantContextFields,
} from '../../src/common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../src/common/tenancy/tenant-transaction';
import { prismaFor } from '../harness/db';
import { createTenant, runPrisma } from '../harness/fixtures';

// The tenant transaction (0.4.3), run as the runtime role on this run's schema.
// The harness stands in for the minters (the session guard, the job loader):
// tests are outside src/, where the lint rule allows mintTenantContext.

type Setting = { tenant: string | null; txid: string };
type OnConnection = { pid: number; tenant: string | null };
const SETTING = Prisma.sql`
  SELECT current_setting('app.tenant_id', true) AS tenant, txid_current()::text AS txid`;
const ON_CONNECTION = Prisma.sql`
  SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS tenant`;
const settingIn = async (tx: TenantTx) =>
  (await tx.$queryRaw<Setting[]>(SETTING))[0];
const connectionOf = async (client: Pick<TenantTx, '$queryRaw'>) =>
  (await client.$queryRaw<OnConnection[]>(ON_CONNECTION))[0];

const fieldsFor = (tenant: Tenant): TenantContextFields => ({
  tenantId: tenant.id,
  actor: { kind: 'SYSTEM', job: 'tenant-transaction-test' },
  requestId: randomUUID(),
  locale: 'en',
});
const contextFor = (tenant: Tenant) => mintTenantContext(fieldsFor(tenant));

describe('the tenant transaction', () => {
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    [a, b] = [await createTenant(), await createTenant()];
  });

  it('queries_run_inside_the_tenant_transaction', async () => {
    const client = prismaFor(inject('databaseUrl'));
    try {
      const tenants = new TenantTransactions(client.prisma);

      // Two tenants at once, on two connections: each sees only its own.
      const runs = await Promise.all(
        [a, b].map((tenant) =>
          tenants.withTenantTransaction(contextFor(tenant), async (tx) => {
            const before = await settingIn(tx);
            const player = await tx.player.create({
              data: {
                tenantId: tenant.id,
                fullName: `Test Player ${randomUUID()}`,
              },
            });
            const after = await settingIn(tx);
            return { tenant, before, after, player };
          }),
        ),
      );
      for (const { tenant, before, after, player } of runs) {
        expect(before.tenant).toBe(tenant.id);
        expect(after).toEqual(before); // one transaction: the same setting, the same txid
        expect(player.tenantId).toBe(tenant.id);
      }

      // The work is the transaction: a failure takes its writes with it.
      const name = `Rolled-back Player ${randomUUID()}`;
      await expect(
        tenants.withTenantTransaction(contextFor(a), async (tx) => {
          await tx.player.create({ data: { tenantId: a.id, fullName: name } });
          throw new Error('the use case failed');
        }),
      ).rejects.toThrow('the use case failed');
      expect(
        await runPrisma().player.count({ where: { fullName: name } }),
      ).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('a_context_cannot_be_built_from_request_input', async () => {
    const client = prismaFor(inject('databaseUrl'));
    try {
      const tenants = new TenantTransactions(client.prisma);
      let ran = false;
      const work = () => {
        ran = true;
        return Promise.resolve();
      };
      const refuse = (candidate: unknown) =>
        expect(
          tenants.withTenantTransaction(candidate as never, work),
        ).rejects.toBeInstanceOf(TenantContextRefused);

      // Every field a request could send, in a body, headers or a token claim.
      await refuse({
        tenantId: a.id,
        actor: { kind: 'USER', userId: randomUUID(), sessionId: randomUUID() },
        requestId: randomUUID(),
        locale: 'en',
      });
      // A minted context sent back as JSON, or copied with another tenant.
      const minted = contextFor(a);
      await refuse(JSON.parse(JSON.stringify(minted)));
      await refuse({ ...minted, tenantId: b.id });
      await refuse(undefined);
      expect(ran).toBe(false); // refused before any connection was taken

      // A minted context cannot be changed, and minting checks its fields.
      expect(() => {
        (minted as { tenantId: string }).tenantId = b.id;
      }).toThrow(TypeError);
      expect(() => {
        (minted.actor as { job: string }).job = 'another';
      }).toThrow(TypeError);
      expect(() =>
        mintTenantContext({ ...fieldsFor(a), tenantId: 'acme' }),
      ).toThrow();
      expect(() =>
        mintTenantContext({
          ...fieldsFor(a),
          role: 'ADMIN',
        } as TenantContextFields),
      ).toThrow();

      // The genuine context is accepted.
      await tenants.withTenantTransaction(minted, work);
      expect(ran).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('the_setting_does_not_outlive_its_transaction', async () => {
    // One connection, so every statement below runs on the same server process.
    const client = prismaFor(inject('databaseUrl'), { max: 1 });
    try {
      const tenants = new TenantTransactions(client.prisma);
      const outside = () => connectionOf(client.prisma);

      const inA = await tenants.withTenantTransaction(
        contextFor(a),
        connectionOf,
      );
      const afterA = await outside();
      expect(inA.tenant).toBe(a.id);
      expect(afterA.pid).toBe(inA.pid);
      expect(afterA.tenant ?? '').toBe(''); // no tenant once the transaction ends

      // Nor after a transaction that failed.
      await expect(
        tenants.withTenantTransaction(contextFor(a), () =>
          Promise.reject(new Error('the use case failed')),
        ),
      ).rejects.toThrow('the use case failed');
      expect((await outside()).tenant ?? '').toBe('');

      // The next tenant on the same connection sees only its own.
      const inB = await tenants.withTenantTransaction(
        contextFor(b),
        connectionOf,
      );
      expect(inB).toEqual({ pid: inA.pid, tenant: b.id });
    } finally {
      await client.close();
    }
  });
});
