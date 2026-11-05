import type { SessionRevocation } from '@prisma/client';
import type { KeysetArgs } from '../../../../common/pagination/paginate';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

/** One of a member's own live sessions, as the session list shows it (0.5.7). */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  /** The assurance the provider asserted at sign-in. */
  readonly acr: string | null;
}

/**
 * The context's member's own sessions (0.5.7): a port the module wires to
 * OwnSessionRepository. Every method is scoped to the context's tenant and
 * member; none takes a member or a tenant, so another member's session is
 * simply not there.
 */
export abstract class OwnSessions {
  /** Live sessions — not revoked, not expired at `at` — newest first. */
  abstract list(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    at: Date,
    args: KeysetArgs,
  ): Promise<SessionSummary[]>;

  /** Ends one session of the member's; false if they have no such session to end. */
  abstract revoke(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    sessionId: string,
    reason: SessionRevocation,
    at: Date,
  ): Promise<boolean>;

  /** Ends every session of the member's; how many it ended. */
  abstract revokeAll(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    reason: SessionRevocation,
    at: Date,
  ): Promise<number>;
}
