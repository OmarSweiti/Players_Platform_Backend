import type { AuditActorType, AuditOutcome, UserRole } from '@prisma/client';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';

/**
 * The version of an audit row's old and new values (0.7.1): 1, the deltas as
 * the writers record them today. 0.7.2's allowlisted structural deltas are 2.
 */
export const AUDIT_SCHEMA_VERSION = 1;

/**
 * What every audit row of a change says about who made it, in which request,
 * and how it ended (0.7.1): the actor as the context held it when it acted —
 * a member's role and session, or the system's job — never looked up later
 * and never an invented account. A change is audited inside its own
 * transaction, so the row of one that rolled back never exists: the outcome
 * is SUCCEEDED.
 */
export interface AuditedChange {
  readonly actorType: AuditActorType;
  readonly userId: string | null;
  readonly actorRole: UserRole | null;
  readonly actorSessionId: string | null;
  readonly actorJob: string | null;
  readonly requestId: string;
  readonly outcome: AuditOutcome;
  readonly schemaVersion: number;
}

export function auditedChangeOf(ctx: AuthorizedTenantContext): AuditedChange {
  const { actor, requestId } = ctx;
  const common = {
    requestId,
    outcome: 'SUCCEEDED',
    schemaVersion: AUDIT_SCHEMA_VERSION,
  } as const;
  return actor.kind === 'USER'
    ? {
        ...common,
        actorType: 'USER',
        userId: actor.userId,
        actorRole: actor.role,
        actorSessionId: actor.sessionId,
        actorJob: null,
      }
    : {
        ...common,
        actorType: 'SYSTEM',
        userId: null,
        actorRole: null,
        actorSessionId: null,
        actorJob: actor.job,
      };
}
