import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { Locale } from '../../../identity/application/ports/identity-provider.port';
import {
  type MemberRecord,
  ProvisioningRecords,
  type TenantRecord,
} from '../../application/ports/provisioning-records.port';

/**
 * Tenant provisioning's records, on the tenant transaction (0.5.9). A tenant is
 * found through the `tenant_directory` view, which shows the runtime role
 * every tenant's slug and nothing more (0.4.5); everything it writes names
 * `ctx.tenantId`, with row-level security as the backstop. Identities are
 * global, and only ever added (0.5.3).
 */
@Injectable()
export class ProvisioningRepository implements ProvisioningRecords {
  async tenantBySlug(tx: TenantTx, slug: string): Promise<TenantRecord | null> {
    const rows = await tx.$queryRaw<
      { id: string; slug: string; domain: string | null; is_active: boolean }[]
    >`SELECT id::text AS id, slug, domain, is_active FROM tenant_directory WHERE slug = ${slug}`;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          slug: row.slug,
          domain: row.domain,
          isActive: row.is_active,
        }
      : null;
  }

  async createTenant(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    tenant: {
      name: string;
      slug: string;
      domain: string | null;
      locale: Locale;
    },
  ): Promise<void> {
    await tx.tenant.create({
      data: {
        id: ctx.tenantId,
        name: tenant.name,
        slug: tenant.slug,
        domain: tenant.domain,
        defaultLocale: tenant.locale,
      },
      select: { id: true },
    });
  }

  async identityFor(
    tx: TenantTx,
    issuer: string,
    subject: string,
  ): Promise<string> {
    const found = await tx.identity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { id: true },
    });
    if (found) return found.id;
    const { id } = await tx.identity.create({
      data: { issuer, subject },
      select: { id: true },
    });
    return id;
  }

  memberByEmail(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    normalizedEmail: string,
  ): Promise<MemberRecord | null> {
    return tx.user.findFirst({
      where: { tenantId: ctx.tenantId, normalizedEmail },
      select: { id: true, role: true, identityId: true },
    });
  }

  async addOwner(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    owner: { email: string; normalizedEmail: string; identityId: string },
  ): Promise<string> {
    const { id } = await tx.user.create({
      data: {
        tenantId: ctx.tenantId,
        email: owner.email,
        normalizedEmail: owner.normalizedEmail,
        identityId: owner.identityId,
        role: 'OWNER',
      },
      select: { id: true },
    });
    return id;
  }
}
