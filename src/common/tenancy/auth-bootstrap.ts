import { Injectable } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { TenantId } from './tenant-context';
import type { TenantTx } from './tenant-transaction';
import { NoAccountHereError, type HostTenant } from './tenant-resolver';

/** Who the identity provider proved signed in, as a session records it. */
export interface ProvenIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly sid?: string;
  readonly acr?: string;
  readonly amr: readonly string[];
  readonly authTime: Date;
}

/** A session about to open: the digest of its token, and its lifetimes. */
export interface NewSession {
  /** SHA-256 of the cookie's value: the value itself is never stored. */
  readonly tokenHash: Uint8Array;
  readonly openedAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

/**
 * Whether a member of `role` may hold a session at the assurance `acr`: the
 * identity module's policy (0.5.8), handed in so that this stays a narrow
 * reader and writer.
 */
export type Admits = (role: UserRole, acr: string | undefined) => boolean;

/** What opening a session came to (0.5.5; 0.5.8). */
export type OpenedSession =
  | {
      readonly kind: 'opened';
      readonly sessionId: string;
      readonly memberId: string;
    }
  /** No identity, no membership, or one inactive or archived. */
  | { readonly kind: 'no-member' }
  /** A member whose role needs more assurance than the provider asserted. */
  | { readonly kind: 'needs-assurance' };

/** What a step-up came to (0.5.8). */
export type SteppedUp =
  | { readonly kind: 'stepped-up'; readonly absoluteExpiresAt: Date }
  /** The session ended, expired or lost its member meanwhile. */
  | { readonly kind: 'gone' }
  /** The provider proved someone other than the session's person. */
  | { readonly kind: 'another-person' }
  | { readonly kind: 'needs-assurance' };

/** A pending invitation, as a sign-in that carries it begins (0.5.10). */
export interface PendingInvitation {
  /** The address invited: the provider is told whom to expect. */
  readonly email: string;
  /** The language its email was written in, which the sign-in pages speak. */
  readonly locale: 'ar' | 'en';
}

/** Who the provider proved signed in, with the address it asserted (0.5.10). */
export interface InvitedPerson {
  readonly issuer: string;
  readonly subject: string;
  /** The asserted address in users' normal form (normalizeEmail); null if none. */
  readonly normalizedEmail: string | null;
  /** Whether the provider asserts the person proved they hold that address. */
  readonly emailVerified: boolean;
}

/**
 * Whether a member holding `granter` may give `role` (the users module's
 * role-grants policy), handed in so that this stays a narrow reader and writer.
 */
export type MayGrant = (granter: UserRole, role: UserRole) => boolean;

/** What accepting an invitation came to (0.5.10). */
export type AcceptedInvitation =
  | { readonly kind: 'accepted'; readonly memberId: string }
  | {
      readonly kind: 'refused';
      /**
       * What failed, never a value: no pending invitation by that token; an
       * address unverified or not the invitation's; an inviter no longer
       * able to grant its role; or a membership already there.
       */
      readonly check: 'invitation' | 'address' | 'inviter' | 'member';
    };

/** A session as authentication reads it (0.5.6), with its member's standing. */
export interface StoredSession {
  readonly id: string;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly authTime: Date;
  readonly acr: string | null;
  readonly member: {
    readonly id: string;
    readonly role: UserRole;
    readonly isActive: boolean;
    readonly deletedAt: Date | null;
  };
}

/**
 * The database before anyone is signed in (0.5.5; docs/reference/
 * architecture.md, "Authentication and trusted tenancy"). Sign-in, and the
 * session guard before it has a member (0.5.6), know only the tenant of the
 * host (TenantResolver): no tenant context exists until a session holds.
 * These are the few reads and writes they need there, each in
 * a transaction of the host's tenant under row-level security, selecting
 * authentication fields only — and accepting an invitation, the one way a
 * membership is made at sign-in (0.5.10). It mints no context and offers no
 * generic access; tenant data is reached only through a context the session
 * guard mints (0.5.6).
 */
@Injectable()
export class AuthBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  /** The language the tenant's members start in. */
  async localeOf(tenant: HostTenant): Promise<'ar' | 'en'> {
    const row = await this.inTenant(tenant, (tx) =>
      tx.tenant.findUnique({
        where: { id: tenant.id },
        select: { defaultLocale: true },
      }),
    );
    if (!row) throw new NoAccountHereError();
    return row.defaultLocale;
  }

  /**
   * Opens a session for the identity's membership in the tenant, in one
   * transaction with the lookup, if it has one that may sign in — active, not
   * archived, and admitted at the asserted assurance (0.5.8). A membership is
   * found by its identity only, never by an email address (0.5.3).
   */
  openSession(
    tenant: HostTenant,
    identity: ProvenIdentity,
    session: NewSession,
    admits: Admits,
  ): Promise<OpenedSession> {
    return this.inTenant(tenant, async (tx) => {
      const person = await tx.identity.findUnique({
        where: {
          issuer_subject: {
            issuer: identity.issuer,
            subject: identity.subject,
          },
        },
        select: { id: true },
      });
      if (!person) return { kind: 'no-member' };
      const member = await tx.user.findFirst({
        where: {
          tenantId: tenant.id,
          identityId: person.id,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true, role: true },
      });
      if (!member) return { kind: 'no-member' };
      if (!admits(member.role, identity.acr))
        return { kind: 'needs-assurance' };
      const { id } = await tx.userSession.create({
        data: {
          tenantId: tenant.id,
          userId: member.id,
          identityId: person.id,
          tokenHash: new Uint8Array(session.tokenHash),
          issuer: identity.issuer,
          subject: identity.subject,
          providerSid: identity.sid,
          acr: identity.acr,
          amr: [...identity.amr],
          authTime: identity.authTime,
          createdAt: session.openedAt,
          lastSeenAt: session.openedAt,
          idleExpiresAt: session.idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
        },
        select: { id: true },
      });
      return { kind: 'opened', sessionId: id, memberId: member.id };
    });
  }

  /**
   * A step-up (0.5.8): the session the browser holds, authenticated again by
   * the same person, is updated in place — its token replaced, its
   * `auth_time`, `acr`, `amr` and provider session renewed — so that its id,
   * its sign-in time and its absolute expiry stay. In one transaction: the
   * session must still be live under `currentTokenHash`, its member active,
   * the provider's person its own, and the member admitted at the new
   * assurance; otherwise nothing changes.
   */
  stepUpSession(
    tenant: HostTenant,
    current: { sessionId: string; tokenHash: Uint8Array },
    identity: ProvenIdentity,
    renewal: {
      tokenHash: Uint8Array;
      at: Date;
      idleExpiresAt: (absoluteExpiresAt: Date) => Date;
    },
    admits: Admits,
  ): Promise<SteppedUp> {
    return this.inTenant(tenant, async (tx) => {
      const where = {
        id: current.sessionId,
        tenantId: tenant.id,
        tokenHash: new Uint8Array(current.tokenHash),
        revokedAt: null,
      };
      const row = await tx.userSession.findFirst({
        where,
        select: {
          issuer: true,
          subject: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          user: { select: { role: true, isActive: true, deletedAt: true } },
        },
      });
      if (
        !row ||
        row.idleExpiresAt <= renewal.at ||
        row.absoluteExpiresAt <= renewal.at ||
        !row.user.isActive ||
        row.user.deletedAt !== null
      ) {
        return { kind: 'gone' };
      }
      if (row.issuer !== identity.issuer || row.subject !== identity.subject) {
        return { kind: 'another-person' };
      }
      if (!admits(row.user.role, identity.acr)) {
        return { kind: 'needs-assurance' };
      }
      const { count } = await tx.userSession.updateMany({
        where,
        data: {
          tokenHash: new Uint8Array(renewal.tokenHash),
          providerSid: identity.sid,
          acr: identity.acr,
          amr: [...identity.amr],
          authTime: identity.authTime,
          lastSeenAt: renewal.at,
          idleExpiresAt: renewal.idleExpiresAt(row.absoluteExpiresAt),
          revision: { increment: 1 },
        },
      });
      return count === 1
        ? { kind: 'stepped-up', absoluteExpiresAt: row.absoluteExpiresAt }
        : { kind: 'gone' };
    });
  }

  /**
   * The invitation whose token hashes to `tokenHash` in the tenant, if it is
   * pending at `at` (0.5.10): neither accepted nor revoked, and not expired.
   */
  pendingInvitation(
    tenant: HostTenant,
    tokenHash: Uint8Array,
    at: Date,
  ): Promise<PendingInvitation | null> {
    return this.inTenant(tenant, (tx) =>
      tx.invitation.findFirst({
        where: {
          tenantId: tenant.id,
          tokenHash: new Uint8Array(tokenHash),
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: at },
        },
        select: { email: true, locale: true },
      }),
    );
  }

  /**
   * Accepts the invitation whose token hashes to `tokenHash` for the person
   * the provider proved signed in (0.5.10; ADR-0002): proof of the mailbox —
   * the token its email carried — and of the identity — the provider's
   * verified address, the invitation's own — never the address alone. Its
   * inviter must still be an active member who may grant its role. In one
   * transaction, holding the invitation's row so that a second acceptance
   * waits and then finds it taken: the identity is found or added, the
   * membership made with the invited role, the invitation closed as
   * accepted by them, and the acceptance audited. A refusal changes nothing.
   */
  acceptInvitation(
    tenant: HostTenant,
    tokenHash: Uint8Array,
    person: InvitedPerson,
    at: Date,
    mayGrant: MayGrant,
  ): Promise<AcceptedInvitation> {
    const refused = (check: 'invitation' | 'address' | 'inviter' | 'member') =>
      ({ kind: 'refused', check }) as const;
    return this.inTenant(tenant, async (tx) => {
      const digest = new Uint8Array(tokenHash);
      await tx.$queryRaw`
        SELECT id FROM invitations
         WHERE tenant_id = ${tenant.id}::uuid AND token_hash = ${digest}
           FOR UPDATE`;
      const invitation = await tx.invitation.findUnique({
        where: {
          tenantId_tokenHash: { tenantId: tenant.id, tokenHash: digest },
        },
        select: {
          id: true,
          email: true,
          normalizedEmail: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          invitedBy: {
            select: { role: true, isActive: true, deletedAt: true },
          },
        },
      });
      if (
        !invitation ||
        invitation.acceptedAt !== null ||
        invitation.revokedAt !== null ||
        invitation.expiresAt <= at
      ) {
        return refused('invitation');
      }
      if (
        !person.emailVerified ||
        person.normalizedEmail !== invitation.normalizedEmail
      ) {
        return refused('address');
      }
      const inviter = invitation.invitedBy;
      if (
        !inviter.isActive ||
        inviter.deletedAt !== null ||
        !mayGrant(inviter.role, invitation.role)
      ) {
        return refused('inviter');
      }
      const key = { issuer: person.issuer, subject: person.subject };
      const known = await tx.identity.findUnique({
        where: { issuer_subject: key },
        select: { id: true },
      });
      const taken = await tx.user.findFirst({
        where: {
          tenantId: tenant.id,
          OR: [
            { normalizedEmail: invitation.normalizedEmail },
            ...(known ? [{ identityId: known.id }] : []),
          ],
        },
        select: { id: true },
      });
      if (taken) return refused('member');
      // Identities are only ever added (0.5.3): one added meanwhile is kept.
      await tx.identity.createMany({ data: [key], skipDuplicates: true });
      const identity = await tx.identity.findUniqueOrThrow({
        where: { issuer_subject: key },
        select: { id: true },
      });
      const member = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: invitation.email,
          normalizedEmail: invitation.normalizedEmail,
          role: invitation.role,
          identityId: identity.id,
        },
        select: { id: true },
      });
      await tx.invitation.update({
        where: { id_tenantId: { id: invitation.id, tenantId: tenant.id } },
        data: {
          acceptedAt: at,
          acceptedMemberId: member.id,
          acceptedIdentityId: identity.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: member.id,
          action: 'invitation.accepted',
          entityType: 'Invitation',
          entityId: invitation.id,
          oldValues: { status: 'pending' },
          newValues: {
            status: 'accepted',
            memberId: member.id,
            role: invitation.role,
          },
        },
      });
      return { kind: 'accepted', memberId: member.id };
    });
  }

  /**
   * The session whose token hashes to `tokenHash` in the tenant (0.5.6), with
   * its member as they stand now: read from PostgreSQL on every request, so
   * that a revocation or a deactivation holds from the next one.
   */
  async sessionOf(
    tenant: HostTenant,
    tokenHash: Uint8Array,
  ): Promise<StoredSession | null> {
    const row = await this.inTenant(tenant, (tx) =>
      tx.userSession.findUnique({
        where: {
          tenantId_tokenHash: {
            tenantId: tenant.id,
            tokenHash: new Uint8Array(tokenHash),
          },
        },
        select: {
          id: true,
          revokedAt: true,
          lastSeenAt: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          authTime: true,
          acr: true,
          user: {
            select: { id: true, role: true, isActive: true, deletedAt: true },
          },
        },
      }),
    );
    if (!row) return null;
    const { user, ...session } = row;
    return { ...session, member: user };
  }

  /**
   * Moves a live session's idle expiry (0.5.6): never past its absolute one,
   * and never for a session revoked meanwhile.
   */
  async renewSession(
    tenant: HostTenant,
    sessionId: string,
    seenAt: Date,
    idleExpiresAt: Date,
  ): Promise<void> {
    await this.inTenant(tenant, (tx) =>
      tx.userSession.updateMany({
        where: {
          id: sessionId,
          tenantId: tenant.id,
          revokedAt: null,
          absoluteExpiresAt: { gte: idleExpiresAt },
        },
        data: {
          lastSeenAt: seenAt,
          idleExpiresAt,
          revision: { increment: 1 },
        },
      }),
    );
  }

  /**
   * Ends the sessions a provider's back-channel logout names (0.5.7), in
   * every tenant, active or not: those of `sid` (and of `subject`, when the
   * token names both), or every session of `subject` when it names no `sid`.
   * A named subject is first resolved to its identity, so each tenant's
   * lookup is the `(tenant_id, identity_id, provider_sid)` index; a subject
   * Sadara has never seen has no sessions. Each tenant is its own transaction
   * under row-level security; there is no scan across tenants, and a logout
   * naming neither ends nothing.
   */
  async revokeProviderSessions(
    logout: { issuer: string; subject?: string; sid?: string },
    at: Date,
  ): Promise<number> {
    let named: Prisma.UserSessionWhereInput;
    if (logout.subject !== undefined) {
      const person = await this.prisma.identity.findUnique({
        where: {
          issuer_subject: { issuer: logout.issuer, subject: logout.subject },
        },
        select: { id: true },
      });
      if (!person) return 0;
      named = {
        identityId: person.id,
        ...(logout.sid !== undefined ? { providerSid: logout.sid } : {}),
      };
    } else if (logout.sid !== undefined) {
      named = { issuer: logout.issuer, providerSid: logout.sid };
    } else {
      return 0;
    }
    const tenants = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM tenant_directory`;
    let revoked = 0;
    for (const { id } of tenants) {
      const { count } = await this.inTenant({ id: id as TenantId }, (tx) =>
        tx.userSession.updateMany({
          where: { tenantId: id, revokedAt: null, ...named },
          data: {
            revokedAt: at,
            revokeReason: 'PROVIDER_LOGOUT',
            revision: { increment: 1 },
          },
        }),
      );
      revoked += count;
    }
    return revoked;
  }

  /** `work` in one transaction as the tenant, as TenantTransactions does. */
  private inTenant<T>(
    tenant: Pick<HostTenant, 'id'>,
    work: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      return work(tx);
    });
  }
}
