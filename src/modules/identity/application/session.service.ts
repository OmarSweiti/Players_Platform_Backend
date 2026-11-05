import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  AuthenticationRequiredError,
  SessionExpiredError,
} from '../../../common/errors/domain-error';
import type { SessionMember } from '../../../common/interfaces/request-with-user.interface';
import { AuthBootstrap } from '../../../common/tenancy/auth-bootstrap';
import {
  type HostTenant,
  NoAccountHereError,
  TenantResolver,
} from '../../../common/tenancy/tenant-resolver';
import { CLOCK, type Clock } from '../../../common/time/clock';
import { digestOf, isSecret } from '../domain/secrets';
import { idleExpiryAt } from '../domain/session-lifetime';

/** A session that holds, and the member it signs in. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  /** SHA-256 of the cookie's value: what the CSRF token is derived from. */
  readonly tokenHash: Buffer;
  readonly member: SessionMember;
}

/**
 * How often a session's idle expiry moves: at most once a minute, so that a
 * busy member does not write on every request. A session may then lapse up
 * to a minute early, never late.
 */
export const RENEW_AFTER_MS = 60 * 1000;

/**
 * Sessions authenticate requests (0.5.6; ADR-0003, SR-AUTH-003). The cookie
 * names a session in the tenant of the host it is sent to (a `__Host-`
 * cookie is never sent to another); PostgreSQL is asked on every request,
 * not a cache, so that a revoked session, a deactivated or archived member,
 * or an inactive tenant is refused from the very next request.
 *
 * Refused as AUTHENTICATION_REQUIRED: no cookie, a host that names no active
 * tenant, an unknown or revoked session, a member no longer active. Past its
 * idle (30 minutes) or absolute (12 hours) expiry: SESSION_EXPIRED. A live
 * session's idle expiry moves with use, never past the absolute one.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly tenants: TenantResolver,
    private readonly bootstrap: AuthBootstrap,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async authenticate(input: {
    arrival: Pick<Request, 'hostname'>;
    /** The session cookie, as the browser sent it, if it did. */
    token: unknown;
  }): Promise<AuthenticatedSession> {
    if (!isSecret(input.token)) {
      throw new AuthenticationRequiredError('no session cookie');
    }
    const tenant = await this.tenantOf(input.arrival);
    const tokenHash = digestOf(input.token);
    const session = await this.bootstrap.sessionOf(tenant, tokenHash);
    if (!session || session.revokedAt !== null) {
      throw new AuthenticationRequiredError('no live session');
    }
    const { member } = session;
    if (!member.isActive || member.deletedAt !== null) {
      throw new AuthenticationRequiredError('the member is not active');
    }
    const now = this.clock.now();
    if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      throw new SessionExpiredError('the session has expired');
    }
    if (now.getTime() - session.lastSeenAt.getTime() >= RENEW_AFTER_MS) {
      await this.bootstrap.renewSession(
        tenant,
        session.id,
        now,
        idleExpiryAt(now, session.absoluteExpiresAt),
      );
    }
    return {
      sessionId: session.id,
      tokenHash,
      member: { id: member.id, tenantId: tenant.id, role: member.role },
    };
  }

  /** The host's tenant; a host that names none signs nobody in. */
  private async tenantOf(
    arrival: Pick<Request, 'hostname'>,
  ): Promise<HostTenant> {
    try {
      return await this.tenants.resolve(arrival);
    } catch (error) {
      if (error instanceof NoAccountHereError) {
        throw new AuthenticationRequiredError('no tenant at this host');
      }
      throw error;
    }
  }
}
