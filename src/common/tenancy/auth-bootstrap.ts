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
 * authentication fields only. It mints no context and offers no generic
 * access; tenant data is reached only through a context the session guard
 * mints (0.5.6).
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
