import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';
import type {
  AuthorizedTenantContext,
  TenantClient,
} from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';
import { AUDIT_SCHEMA_VERSION, auditedChangeOf } from './audit-actor';
import {
  AUDITED_ACTIONS,
  type AuditAction,
  type AuditEvent,
  type AuditValue,
  type AuditValues,
} from './audited-actions';

/** The longest user agent an audit row keeps: the column's bound, in characters. */
export const USER_AGENT_MAX = 500;

/** The longest reason an audit row keeps: the column's bound, in characters. */
export const REASON_MAX = 500;

/**
 * An audit event its catalog does not allow (audited-actions.ts): a field the
 * action does not list, a role change without its state before and after, an
 * over-long reason. A programming error — the change it would have recorded
 * is aborted with it, and the client is answered as for any fault.
 */
export class AuditEventRefused extends Error {
  constructor(reason: string) {
    super(`audit event refused: ${reason}`);
    this.name = 'AuditEventRefused';
  }
}

/** The member an invitation's acceptance makes: it acts before any context exists. */
export interface AcceptingMember {
  readonly tenantId: string;
  readonly memberId: string;
  readonly role: UserRole;
  readonly requestId: string | null;
}

/**
 * Audit inside the business transaction (0.7.2; SR-AUD-002–004, SR-ACL-006;
 * docs/reference/database.md). `record` writes on the caller's transaction,
 * so the entry commits with the change or not at all: an entry that cannot be
 * written aborts the change, and a change that rolls back leaves no entry.
 * Its payload is an allowlisted structural delta — who, what, when, tenant,
 * request, before and after — with personal and confidential values replaced
 * by references to where they live. The client's address and user agent are
 * kept only as values that cannot fail the insert: an address PostgreSQL's
 * inet would refuse is dropped, and a user agent is cut to its bound.
 */
@Injectable()
export class AuditService {
  /** Records `event`, made under `ctx`, inside `tx`. */
  async record<A extends AuditAction>(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    event: AuditEvent<A>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        ...auditedChangeOf(ctx),
        ...clientOf(ctx.client),
        ...payloadOf(event),
      },
      select: { id: true },
    });
  }

  /**
   * Records `event`, made by the member an invitation's acceptance creates,
   * inside `tx`: at sign-in, before any context or session of theirs exists.
   */
  async recordAcceptance(
    tx: TenantTx,
    member: AcceptingMember,
    event: AuditEvent<'invitation.accepted'>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: member.tenantId,
        actorType: 'USER',
        userId: member.memberId,
        actorRole: member.role,
        requestId: member.requestId,
        outcome: 'SUCCEEDED',
        schemaVersion: AUDIT_SCHEMA_VERSION,
        ...payloadOf(event),
      },
      select: { id: true },
    });
  }
}

/** The event's columns: its entity, its reason, and its delta, allowlisted. */
function payloadOf<A extends AuditAction>(event: AuditEvent<A>) {
  const action = AUDITED_ACTIONS[event.action] as {
    readonly entity: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly beforeAndAfter?: true;
  };
  if (action.beforeAndAfter) {
    for (const field of Object.keys(action.fields)) {
      if (!hasField(event.before, field) || !hasField(event.after, field)) {
        throw new AuditEventRefused(
          `${event.action} records ${field} before and after`,
        );
      }
    }
  }
  if (event.reason !== undefined && [...event.reason].length > REASON_MAX) {
    throw new AuditEventRefused(`${event.action}'s reason is over-long`);
  }
  const delta = (values: AuditValues<A> | undefined) =>
    values === undefined
      ? undefined
      : deltaOf(event.action, action, event.entityId, values);
  return {
    action: event.action,
    entityType: action.entity,
    entityId: event.entityId,
    reason: event.reason ?? null,
    oldValues: delta(event.before),
    newValues: delta(event.after),
  };
}

function hasField(values: object | undefined, field: string): boolean {
  return values !== undefined && Object.hasOwn(values, field);
}

/**
 * The delta as recorded: each field the action lists, an operational value as
 * it is (an instant in ISO 8601), a personal or confidential one as a
 * reference — `{ ref: '<Entity>/<id>/<field>', class }` — never the value.
 */
function deltaOf(
  name: string,
  action: {
    readonly entity: string;
    readonly fields: Readonly<Record<string, string>>;
  },
  entityId: string,
  values: object,
): Prisma.InputJsonObject {
  const recorded: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [field, value] of Object.entries(values) as Array<
    [string, AuditValue | undefined]
  >) {
    const fieldClass = action.fields[field];
    if (fieldClass === undefined) {
      throw new AuditEventRefused(`${name} lists no field ${field}`);
    }
    if (value === undefined) continue;
    recorded[field] =
      fieldClass === 'OPERATIONAL'
        ? valueOf(name, field, value)
        : { ref: `${action.entity}/${entityId}/${field}`, class: fieldClass };
  }
  return recorded;
}

function valueOf(
  name: string,
  field: string,
  value: AuditValue,
): Prisma.InputJsonValue | null {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item === 'object')) {
      throw new AuditEventRefused(`${name}'s ${field} is not flat`);
    }
    return [...(value as readonly (string | number | boolean)[])];
  }
  if (value !== null && typeof value === 'object') {
    throw new AuditEventRefused(`${name}'s ${field} is not flat`);
  }
  return value;
}

/**
 * The request's client as an audit row keeps it (DB-56): an address only if
 * PostgreSQL's inet takes it — no zone, no port — and a user agent cut to its
 * bound, by characters. Neither can fail the insert, and so the change.
 */
function clientOf(client: TenantClient | undefined): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const address = client?.address?.replace(/%.*$/, '');
  const userAgent = client?.userAgent;
  return {
    ipAddress: address !== undefined && isIP(address) !== 0 ? address : null,
    userAgent:
      userAgent === undefined || userAgent === ''
        ? null
        : [...userAgent].slice(0, USER_AGENT_MAX).join(''),
  };
}
