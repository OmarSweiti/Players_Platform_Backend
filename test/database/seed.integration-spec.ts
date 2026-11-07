import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../src/common/errors/domain-error';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { parseCivilDate } from '../../src/common/time/civil-date';
import { parseTimeZone } from '../../src/common/time/time-zone';
import {
  DEVELOPMENT_DATA,
  type DevelopmentData,
  developmentId,
  TENANT_ROLES,
} from '../../src/database/development-data';
import { seedDevelopmentData } from '../../src/database/seed-development-data';
import { normalizeEmail } from '../../src/modules/users/domain/email';
import {
  asTenant,
  createTenant,
  runPrisma,
  testContext,
} from '../harness/fixtures';

// The synthetic seed (0.5.11), on this run's schema, as the runtime role:
// each tenant written in its own tenant transaction, as `just seed` does.
const ISSUER = 'http://localhost:8080/realms/sadara';

const seed = (data: DevelopmentData = DEVELOPMENT_DATA) =>
  seedDevelopmentData(
    new TenantTransactions(runPrisma()),
    (tenantId) => testContext(tenantId, 'seed'),
    ISSUER,
    data,
  );

/** Every seeded row, every column: the tenants, their members and players, and the identities. */
async function everything(data: DevelopmentData = DEVELOPMENT_DATA) {
  const tenants = await Promise.all(
    data.tenants.map((tenant) =>
      asTenant(tenant.id, async (tx) => ({
        tenant: await tx.tenant.findUnique({ where: { id: tenant.id } }),
        members: await tx.user.findMany({
          where: { tenantId: tenant.id },
          orderBy: { id: 'asc' },
        }),
        players: await tx.player.findMany({
          where: { tenantId: tenant.id },
          orderBy: { id: 'asc' },
        }),
      })),
    ),
  );
  const identities = await asTenant(data.tenants[0].id, (tx) =>
    tx.identity.findMany({
      where: {
        issuer: ISSUER,
        subject: { in: data.members.map((m) => m.subject) },
      },
      orderBy: { id: 'asc' },
    }),
  );
  return { tenants, identities };
}

/** One tenant's worth of data, of its own slug, for the refusals. */
function probeData(): DevelopmentData {
  const slug = `seed-probe-${randomUUID().slice(0, 8)}`;
  const email = `coach@${slug}.test`;
  return {
    tenants: [
      {
        id: developmentId(`tenant:${slug}`),
        slug,
        name: 'Probe Agency',
        defaultLocale: 'en',
        timezone: parseTimeZone('Europe/London'),
        defaultCurrency: 'GBP',
      },
    ],
    members: [
      {
        id: developmentId(`member:${email}`),
        tenantSlug: slug,
        role: 'COACH',
        email,
        normalizedEmail: normalizeEmail(email),
        firstName: 'Coach',
        lastName: 'Probe',
        subject: developmentId(`account:${email}`),
      },
    ],
    players: [
      {
        id: developmentId(`player:${slug}:1`),
        tenantSlug: slug,
        fullName: 'Probe Player',
        dateOfBirth: parseCivilDate('2004-05-06'),
        position: 'CM',
        footPreference: 'RIGHT',
        jerseyNumber: 8,
      },
    ],
  };
}

describe('the synthetic seed', () => {
  it('the_seed_is_idempotent', async () => {
    const counts = (created: number, updated: number, unchanged: number) => ({
      created,
      updated,
      unchanged,
    });
    expect(await seed()).toEqual({
      tenants: counts(2, 0, 0),
      identities: counts(34, 0, 0),
      members: counts(34, 0, 0),
      players: counts(10, 0, 0),
    });
    const first = await everything();

    // A second seed writes nothing at all: not a row, not an updatedAt.
    expect(await seed()).toEqual({
      tenants: counts(0, 0, 2),
      identities: counts(0, 0, 34),
      members: counts(0, 0, 34),
      players: counts(0, 0, 10),
    });
    expect(await everything()).toEqual(first);

    // What was changed by hand is brought back, and only that.
    const [sadara] = DEVELOPMENT_DATA.tenants;
    const coach = DEVELOPMENT_DATA.members.find(
      (m) => m.tenantSlug === 'sadara' && m.role === 'COACH',
    )!;
    const scout = DEVELOPMENT_DATA.members.find(
      (m) => m.tenantSlug === 'sadara' && m.role === 'SCOUT',
    )!;
    const player = DEVELOPMENT_DATA.players.find(
      (p) => p.tenantSlug === 'sadara',
    )!;
    await asTenant(sadara.id, async (tx) => {
      await tx.tenant.update({
        where: { id: sadara.id },
        data: { timezone: 'Asia/Riyadh' },
      });
      await tx.user.update({
        where: { id: coach.id },
        data: { role: 'ADMIN' },
      });
      await tx.user.update({
        where: { id: scout.id },
        data: { isActive: false, deletedAt: new Date() },
      });
      await tx.player.update({
        where: { id: player.id },
        data: { fullName: 'Renamed', status: 'RETIRED' },
      });
    });
    expect(await seed()).toEqual({
      tenants: counts(0, 1, 1),
      identities: counts(0, 0, 34),
      members: counts(0, 2, 32),
      players: counts(0, 1, 9),
    });
    const withoutUpdatedAt = (all: Awaited<ReturnType<typeof everything>>) =>
      JSON.parse(
        JSON.stringify(all, (key, value: unknown) =>
          key === 'updatedAt' ? undefined : value,
        ),
      ) as unknown;
    expect(withoutUpdatedAt(await everything())).toEqual(
      withoutUpdatedAt(first),
    );
  });

  it('seed_data_uses_only_reserved_domains', async () => {
    await seed();
    const { tenants, identities } = await everything();
    expect(tenants.map(({ tenant }) => tenant?.slug)).toEqual([
      'sadara',
      'northwind',
    ]);
    const bySubject = new Map(identities.map((i) => [i.id, i.subject]));
    for (const { tenant, members, players } of tenants) {
      // Hosts come from the slug and APEX_DOMAIN (.localhost), never a domain of the seed's.
      expect(tenant?.domain).toBeNull();
      expect(members.map((m) => m.role).sort()).toEqual(
        [...TENANT_ROLES].sort(),
      );
      for (const member of members) {
        expect(member.email).toMatch(/^[a-z-]+@[a-z]+\.test$/);
        expect(member.normalizedEmail).toBe(member.email);
        expect(member.phone).toBeNull();
        // Linked through its account's subject, which the address only names.
        expect(bySubject.get(member.identityId!)).toBe(
          developmentId(`account:${member.email}`),
        );
      }
      for (const player of players) {
        expect(player.agentEmail).toBeNull();
        expect(player.agentPhone).toBeNull();
        expect(player.passportNumber).toBeNull();
        expect(player.emergencyPhone).toBeNull();
      }
    }
    // Nothing of the old seed: no platform tenant, no SUPER_ADMIN.
    const [platform] = await runPrisma().$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM tenant_directory WHERE slug = 'platform-admin'`;
    expect(platform.n).toBe(0n);
    expect(
      tenants.flatMap(({ members }) =>
        members.filter((m) => m.role === 'SUPER_ADMIN'),
      ),
    ).toEqual([]);
  });

  it('the_seed_never_takes_a_tenant_or_relinks_a_member_it_did_not_make', async () => {
    // A tenant of the seed's slug that the seed did not make: refused, and
    // nothing written in it.
    const taken = probeData();
    const other = await createTenant({ slug: taken.tenants[0].slug });
    await expect(seed(taken)).rejects.toThrow(ConflictError);
    await expect(seed(taken)).rejects.toThrow(/did not make/);
    expect(
      await asTenant(other.id, (tx) =>
        tx.user.count({ where: { tenantId: other.id } }),
      ),
    ).toBe(0);

    // A member the seed made, since linked to another identity: never relinked.
    const data = probeData();
    await seed(data);
    const [tenant] = data.tenants;
    const [member] = data.members;
    const stranger = await asTenant(tenant.id, async (tx) => {
      const identity = await tx.identity.create({
        data: { issuer: ISSUER, subject: randomUUID() },
      });
      await tx.user.update({
        where: { id: member.id },
        data: { identityId: identity.id },
      });
      return identity.id;
    });
    await expect(seed(data)).rejects.toThrow(/never relinks/);
    expect(
      await asTenant(tenant.id, (tx) =>
        tx.user.findUniqueOrThrow({
          where: { id: member.id },
          select: { identityId: true },
        }),
      ),
    ).toEqual({ identityId: stranger });
  });
});
