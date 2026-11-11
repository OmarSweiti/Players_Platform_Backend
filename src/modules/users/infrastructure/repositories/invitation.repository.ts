import { Injectable } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';
import {
  KEYSET_ORDER,
  keysetWhere,
} from '../../../../common/pagination/keyset';
import type { KeysetArgs } from '../../../../common/pagination/paginate';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { Locale } from '../../../identity/application/ports/identity-provider.port';
import {
  InvitationRecords,
  type InvitationView,
  type NewInvitation,
} from '../../application/ports/invitation-records.port';
import type { InvitationStatus } from '../../domain/invitation';

/** What an invitation shows its inviters: never its token's digest. */
const VIEW = {
  id: true,
  email: true,
  role: true,
  locale: true,
  invitedById: true,
  createdAt: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
} as const satisfies Prisma.InvitationSelect;

const OPEN = { acceptedAt: null, revokedAt: null } as const;

/** The rows of `status` at `at`, as statusOf (domain/invitation.ts) reads them. */
function whereStatus(
  status: InvitationStatus,
  at: Date,
): Prisma.InvitationWhereInput {
  switch (status) {
    case 'accepted':
      return { acceptedAt: { not: null } };
    case 'revoked':
      return { revokedAt: { not: null } };
    case 'pending':
      return { ...OPEN, expiresAt: { gt: at } };
    case 'expired':
      return { ...OPEN, expiresAt: { lte: at } };
  }
}

/**
 * Invitations, on the tenant transaction (0.5.10). Every predicate names
 * `ctx.tenantId`; row-level security is the backstop. A token's digest is
 * written here and never read back out.
 */
@Injectable()
export class InvitationRepository implements InvitationRecords {
  async activeRoleOf(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    memberId: string,
  ): Promise<UserRole | null> {
    const member = await tx.user.findFirst({
      where: {
        id: memberId,
        tenantId: ctx.tenantId,
        isActive: true,
        deletedAt: null,
      },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  async tenantLocale(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
  ): Promise<Locale> {
    const { defaultLocale } = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      select: { defaultLocale: true },
    });
    return defaultLocale;
  }

  agencyOf(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
  ): Promise<{
    name: string;
    slug: string;
    domain: string | null;
    timezone: string;
  }> {
    return tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      select: { name: true, slug: true, domain: true, timezone: true },
    });
  }

  async isMemberAddress(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    normalizedEmail: string,
  ): Promise<boolean> {
    const member = await tx.user.findUnique({
      where: {
        tenantId_normalizedEmail: { tenantId: ctx.tenantId, normalizedEmail },
      },
      select: { id: true },
    });
    return member !== null;
  }

  openTo(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    normalizedEmail: string,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    return tx.invitation.findFirst({
      where: { tenantId: ctx.tenantId, normalizedEmail, ...OPEN },
      select: { id: true, expiresAt: true },
    });
  }

  create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitation: NewInvitation,
  ): Promise<InvitationView> {
    return tx.invitation.create({
      data: { tenantId: ctx.tenantId, ...invitation },
      select: VIEW,
    });
  }

  list(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    { status, at }: { status?: InvitationStatus; at: Date },
    { take, after }: KeysetArgs,
  ): Promise<InvitationView[]> {
    return tx.invitation.findMany({
      where: {
        AND: [
          { tenantId: ctx.tenantId },
          status ? whereStatus(status, at) : {},
          keysetWhere(after),
        ],
      },
      orderBy: [...KEYSET_ORDER],
      take,
      select: VIEW,
    });
  }

  find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitationId: string,
  ): Promise<InvitationView | null> {
    return tx.invitation.findFirst({
      where: { id: invitationId, tenantId: ctx.tenantId },
      select: VIEW,
    });
  }

  async revoke(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitationId: string,
    at: Date,
  ): Promise<boolean> {
    const { count } = await tx.invitation.updateMany({
      where: { id: invitationId, tenantId: ctx.tenantId, ...OPEN },
      data: { revokedAt: at },
    });
    return count === 1;
  }

  async issueToken(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitationId: string,
    tokenHash: Uint8Array,
    at: Date,
  ): Promise<InvitationView | null> {
    const { count } = await tx.invitation.updateMany({
      where: {
        id: invitationId,
        tenantId: ctx.tenantId,
        ...whereStatus('pending', at),
      },
      data: { tokenHash: new Uint8Array(tokenHash), tokenIssuedAt: at },
    });
    return count === 1 ? this.find(tx, ctx, invitationId) : null;
  }
}
