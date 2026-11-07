import { ConflictError } from '../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../common/tenancy/tenant-context';
import type {
  TenantTransactions,
  TenantTx,
} from '../common/tenancy/tenant-transaction';
import { civilDateToDatabase } from '../common/time/civil-date';
import {
  DEVELOPMENT_DATA,
  type DevelopmentData,
  type DevelopmentTenant,
  developmentId,
} from './development-data';

/** What one kind of record came to: made, brought back to the seed's values, or left as it was. */
export interface SeedCount {
  created: number;
  updated: number;
  unchanged: number;
}

export interface SeedReport {
  tenants: SeedCount;
  identities: SeedCount;
  members: SeedCount;
  players: SeedCount;
}

/** The fields of `wanted` whose value `current` does not hold; a Date by its instant. */
function differences<T extends Record<string, unknown>>(
  current: Record<string, unknown>,
  wanted: T,
): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(wanted) as (keyof T & string)[]) {
    const [was, is] = [current[key], wanted[key]];
    const same =
      was instanceof Date && is instanceof Date
        ? was.getTime() === is.getTime()
        : was === is;
    if (!same) changed[key] = is;
  }
  return changed;
}

const isEmpty = (fields: object) => Object.keys(fields).length === 0;

/**
 * Writes the development data (0.5.11), idempotently: what is missing is made,
 * what differs from the seed's values is brought back to them, and nothing
 * else is written — a second run writes nothing at all, not even an
 * `updatedAt`. Each tenant is one tenant transaction, in its own context, so
 * row-level security accepts its rows only. A membership is linked to its
 * identity by the account's issuer and subject, never by its address, and the
 * seed refuses — it never relinks — a membership that holds another identity,
 * or a tenant of the same slug that it did not make.
 *
 * `issuer` is the API's OIDC_ISSUER: the development realm's accounts are its
 * subjects. No audit entry is written: this is development data, never a
 * tenant's business.
 */
export async function seedDevelopmentData(
  transactions: TenantTransactions,
  contextFor: (tenantId: string) => AuthorizedTenantContext,
  issuer: string,
  data: DevelopmentData = DEVELOPMENT_DATA,
): Promise<SeedReport> {
  const count = (): SeedCount => ({ created: 0, updated: 0, unchanged: 0 });
  const report: SeedReport = {
    tenants: count(),
    identities: count(),
    members: count(),
    players: count(),
  };
  const tally = (kind: keyof SeedReport, outcome: keyof SeedCount) => {
    report[kind][outcome] += 1;
  };

  for (const tenant of data.tenants) {
    await transactions.withTenantTransaction(contextFor(tenant.id), (tx) =>
      seedTenant(tx, tenant, data, issuer, tally),
    );
  }
  return report;
}

async function seedTenant(
  tx: TenantTx,
  tenant: DevelopmentTenant,
  data: DevelopmentData,
  issuer: string,
  tally: (kind: keyof SeedReport, outcome: keyof SeedCount) => void,
): Promise<void> {
  // The directory shows every tenant's slug, and nothing more (0.4.5).
  const [holder] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM tenant_directory WHERE slug = ${tenant.slug}`;
  if (holder && holder.id !== tenant.id) {
    throw new ConflictError(
      `a tenant "${tenant.slug}" exists that the seed did not make: reset the database to seed it`,
    );
  }

  const tenantFields = {
    slug: tenant.slug,
    name: tenant.name,
    domain: null,
    isActive: true,
    defaultLocale: tenant.defaultLocale,
    timezone: tenant.timezone as string,
    defaultCurrency: tenant.defaultCurrency,
  };
  if (!holder) {
    await tx.tenant.create({
      data: { id: tenant.id, ...tenantFields },
      select: { id: true },
    });
    tally('tenants', 'created');
  } else {
    const current = await tx.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: {
        slug: true,
        name: true,
        domain: true,
        isActive: true,
        defaultLocale: true,
        timezone: true,
        defaultCurrency: true,
      },
    });
    const changed = differences(current, tenantFields);
    if (isEmpty(changed)) tally('tenants', 'unchanged');
    else {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: changed,
        select: { id: true },
      });
      tally('tenants', 'updated');
    }
  }

  for (const member of data.members) {
    if (member.tenantSlug !== tenant.slug) continue;
    // Identities are global, and only ever added (0.5.3).
    let identity = await tx.identity.findUnique({
      where: { issuer_subject: { issuer, subject: member.subject } },
      select: { id: true },
    });
    if (identity) tally('identities', 'unchanged');
    else {
      identity = await tx.identity.create({
        data: {
          id: developmentId(`identity:${issuer}\n${member.subject}`),
          issuer,
          subject: member.subject,
        },
        select: { id: true },
      });
      tally('identities', 'created');
    }

    const memberFields = {
      email: member.email,
      role: member.role,
      firstName: member.firstName,
      lastName: member.lastName,
      identityId: identity.id,
      isActive: true,
      deletedAt: null,
    };
    const current = await tx.user.findUnique({
      where: {
        tenantId_normalizedEmail: {
          tenantId: tenant.id,
          normalizedEmail: member.normalizedEmail,
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        identityId: true,
        isActive: true,
        deletedAt: true,
      },
    });
    if (!current) {
      await tx.user.create({
        data: {
          id: member.id,
          tenantId: tenant.id,
          normalizedEmail: member.normalizedEmail,
          ...memberFields,
        },
        select: { id: true },
      });
      tally('members', 'created');
      continue;
    }
    if (current.identityId !== null && current.identityId !== identity.id) {
      throw new ConflictError(
        `the ${member.role} member of "${tenant.slug}" belongs to another identity: the seed never relinks one`,
      );
    }
    const changed = differences(current, memberFields);
    if (isEmpty(changed)) tally('members', 'unchanged');
    else {
      await tx.user.update({
        where: { id_tenantId: { id: current.id, tenantId: tenant.id } },
        data: changed,
        select: { id: true },
      });
      tally('members', 'updated');
    }
  }

  for (const player of data.players) {
    if (player.tenantSlug !== tenant.slug) continue;
    const playerFields = {
      fullName: player.fullName,
      dateOfBirth: civilDateToDatabase(player.dateOfBirth),
      position: player.position,
      footPreference: player.footPreference,
      jerseyNumber: player.jerseyNumber,
      status: 'ACTIVE' as const,
      deletedAt: null,
    };
    const current = await tx.player.findFirst({
      where: { id: player.id, tenantId: tenant.id },
      select: {
        fullName: true,
        dateOfBirth: true,
        position: true,
        footPreference: true,
        jerseyNumber: true,
        status: true,
        deletedAt: true,
      },
    });
    if (!current) {
      await tx.player.create({
        data: { id: player.id, tenantId: tenant.id, ...playerFields },
        select: { id: true },
      });
      tally('players', 'created');
      continue;
    }
    const changed = differences(current, playerFields);
    if (isEmpty(changed)) tally('players', 'unchanged');
    else {
      await tx.player.update({
        where: { id_tenantId: { id: player.id, tenantId: tenant.id } },
        data: changed,
        select: { id: true },
      });
      tally('players', 'updated');
    }
  }
}
