import type { UserRole } from '@prisma/client';
import type { KeysetArgs } from '../../../../common/pagination/paginate';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { Locale } from '../../../identity/application/ports/identity-provider.port';
import type { InvitationStatus } from '../../domain/invitation';

/** An invitation as its inviters see it (0.5.10): never its token's digest. */
export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly locale: Locale;
  readonly invitedById: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** An invitation and what became of it, as the list shows it. */
export interface ListedInvitation extends InvitationView {
  readonly status: InvitationStatus;
}

export interface NewInvitation {
  readonly email: string;
  readonly normalizedEmail: string;
  readonly role: UserRole;
  readonly locale: Locale;
  readonly invitedById: string;
  /** When it is made, by the use case's clock, which its expiry counts from. */
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Invitations and what deciding about one reads (0.5.10): a port the users
 * module wires to InvitationRepository. Every method works in the context's
 * tenant, on its transaction.
 */
export abstract class InvitationRecords {
  /** The role of `memberId`, if they are an active member, not archived. */
  abstract activeRoleOf(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    memberId: string,
  ): Promise<UserRole | null>;

  /** The language the tenant's members start in. */
  abstract tenantLocale(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
  ): Promise<Locale>;

  /**
   * The tenant as its invitation's email names it (0.7.8): its name, where
   * its links point — its own domain, or its slug under the apex domain —
   * and the zone its times are written in.
   */
  abstract agencyOf(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
  ): Promise<{
    name: string;
    slug: string;
    domain: string | null;
    timezone: string;
  }>;

  /** Whether a membership holds the address, an archived one included (0.4.9). */
  abstract isMemberAddress(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    normalizedEmail: string,
  ): Promise<boolean>;

  /** The open invitation to the address, neither accepted nor revoked, if any. */
  abstract openTo(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    normalizedEmail: string,
  ): Promise<{ id: string; expiresAt: Date } | null>;

  abstract create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitation: NewInvitation,
  ): Promise<InvitationView>;

  /** Newest first, of `status` at `at` when one is named. */
  abstract list(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    filter: { status?: InvitationStatus; at: Date },
    args: KeysetArgs,
  ): Promise<InvitationView[]>;

  abstract find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitationId: string,
  ): Promise<InvitationView | null>;

  /** Closes an open invitation at `at`; false if it was not open. */
  abstract revoke(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitationId: string,
    at: Date,
  ): Promise<boolean>;

  /**
   * Keeps a new token's digest on a pending invitation, replacing the last,
   * so that only the newest link works; the invitation, or null when it is
   * not pending at `at`.
   */
  abstract issueToken(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    invitationId: string,
    tokenHash: Uint8Array,
    at: Date,
  ): Promise<InvitationView | null>;
}
