import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
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

export interface OpenedSession {
  readonly sessionId: string;
  readonly memberId: string;
}

/**
 * The database before anyone is signed in (0.5.5; docs/reference/
 * architecture.md, "Authentication and trusted tenancy"). Sign-in knows only
 * the tenant of the host (TenantResolver), and no tenant context exists until
 * a session does: these are the few reads and writes it needs there, each in
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
   * transaction with the lookup: null when it has none that may sign in — no
   * identity, no membership, or one inactive or archived. A membership is
   * found by its identity only, never by an email address (0.5.3).
   */
  openSession(
    tenant: HostTenant,
    identity: ProvenIdentity,
    session: NewSession,
  ): Promise<OpenedSession | null> {
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
      if (!person) return null;
      const member = await tx.user.findFirst({
        where: {
          tenantId: tenant.id,
          identityId: person.id,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!member) return null;
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
      return { sessionId: id, memberId: member.id };
    });
  }

  /** `work` in one transaction as the host's tenant, as TenantTransactions does. */
  private inTenant<T>(
    tenant: HostTenant,
    work: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      return work(tx);
    });
  }
}
