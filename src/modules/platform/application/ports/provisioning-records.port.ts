import type { UserRole } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { Locale } from '../../../identity/application/ports/identity-provider.port';

/** A tenant as the directory shows it: enough to find one by its slug. */
export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly domain: string | null;
  readonly isActive: boolean;
}

/** A membership, as provisioning needs to know it. */
export interface MemberRecord {
  readonly id: string;
  readonly role: UserRole;
  readonly identityId: string | null;
}

/**
 * What tenant provisioning reads and writes in the database (0.5.9): a port
 * the provisioning module wires to ProvisioningRepository. Every method takes
 * the tenant transaction, and the context of the tenant it writes in.
 */
export abstract class ProvisioningRecords {
  /** The tenant with this slug, active or not, from the tenant directory. */
  abstract tenantBySlug(
    tx: TenantTx,
    slug: string,
  ): Promise<TenantRecord | null>;

  /** A new tenant, with the context's id. */
  abstract createTenant(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    tenant: {
      name: string;
      slug: string;
      domain: string | null;
      locale: Locale;
    },
  ): Promise<void>;

  /** The identity of `(issuer, subject)`, added if Sadara has none. */
  abstract identityFor(
    tx: TenantTx,
    issuer: string,
    subject: string,
  ): Promise<string>;

  /** The membership with this address in the context's tenant, archived or not. */
  abstract memberByEmail(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    normalizedEmail: string,
  ): Promise<MemberRecord | null>;

  /** A new OWNER membership, linked to the identity: its id. */
  abstract addOwner(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    owner: { email: string; normalizedEmail: string; identityId: string },
  ): Promise<string>;

  /** The audit entry of a provisioning run that changed something. */
  abstract recordProvisioning(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    changes: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}
