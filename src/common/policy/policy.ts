import type { UserRole } from '@prisma/client';
import {
  type DomainError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../errors/domain-error';
import type {
  AuthorizedTenantContext,
  UserId,
} from '../tenancy/tenant-context';

// Object policies (0.6.3; ADR-0005). A route's permission says a member's role
// may take an action at all (0.6.2); a resource's policy says whether this
// member may take it on this resource. A policy is a pure function of the
// member, the action and what the use case loaded — relationship,
// sensitivity and state; an id is never authorization. The use case
// evaluates it after loading the resource and before returning or changing
// it, inside its tenant transaction, which has already refused a context
// that was not minted — so it holds for every caller: a route, a job or a
// direct call.

/** Why a policy refused. */
export type DenyReason =
  /** A job: no member-facing policy serves one unless it says so. */
  | 'NOT_A_MEMBER'
  /** The action needs a relationship the member does not have: the resource's author, its assignee. */
  | 'UNRELATED'
  /** The member's role does not take this action on this resource, or nobody's does. */
  | 'ROLE'
  /** The resource is confidential, and the member's role is not cleared for it. */
  | 'CONFIDENTIAL'
  /** The resource's state does not allow the action. */
  | 'STATE';

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: DenyReason };

export const ALLOW: Decision = Object.freeze({ allow: true });

export function deny(reason: DenyReason): Decision {
  return Object.freeze({ allow: false, reason });
}

/** The member a policy decides for: who they are and their role in this tenant, from the context alone. */
export interface PolicyMember {
  readonly userId: UserId;
  readonly role: UserRole;
}

/** One action's rule, given the member and the fields of the resource it reads. */
export type Rule<View> = (member: PolicyMember, resource: View) => Decision;

export interface Policy<Action extends string, View> {
  authorize(
    ctx: AuthorizedTenantContext,
    action: Action,
    resource: View,
  ): Decision;
}

/**
 * A resource's policy: one rule for each of its actions, `read` among them,
 * so that a change is never allowed to someone who may not see the resource.
 * A job is refused, and so is an action the policy has no rule for: missing
 * policy denies (I-2).
 */
export function definePolicy<Action extends string, View>(
  rules: Readonly<Record<Action | 'read', Rule<View>>>,
): Policy<Action | 'read', View> {
  return Object.freeze({
    authorize(
      ctx: AuthorizedTenantContext,
      action: Action | 'read',
      resource: View,
    ): Decision {
      if (ctx.actor.kind !== 'USER') return deny('NOT_A_MEMBER');
      const rule: Rule<View> | undefined = Object.hasOwn(rules, action)
        ? rules[action]
        : undefined;
      if (rule === undefined) return deny('ROLE');
      const { userId, role } = ctx.actor;
      return rule({ userId, role }, resource);
    },
  });
}

/**
 * The resource, when the member may read it. A read the policy denies is not
 * found: the same error as absence, so a refusal tells nobody the resource
 * exists (ADR-0005).
 */
export function authorizeRead<View, Resource extends View>(
  ctx: AuthorizedTenantContext,
  policy: Policy<'read', View>,
  resource: Resource | null | undefined,
  notFound: string,
): Resource {
  if (resource == null || !policy.authorize(ctx, 'read', resource).allow) {
    throw new NotFoundError(notFound);
  }
  return resource;
}

/** What a refusal means to the caller, for each reason the use case names. */
export type Refusals = Partial<Record<DenyReason, () => DomainError>>;

/**
 * The resource, when the member may take `action` on it. One they may not
 * read is not found, as a read is. Otherwise a refusal is the use case's own
 * error for its reason, or by default an invalid transition when the state
 * does not allow the action and forbidden for every other reason.
 */
export function authorizeChange<
  Action extends string,
  View,
  Resource extends View,
>(
  ctx: AuthorizedTenantContext,
  policy: Policy<Action | 'read', View>,
  action: Action,
  resource: Resource | null | undefined,
  notFound: string,
  refusals: Refusals = {},
): Resource {
  const visible = authorizeRead(ctx, policy, resource, notFound);
  const decision = policy.authorize(ctx, action, visible);
  if (decision.allow) return visible;
  const refuse = refusals[decision.reason];
  if (refuse) throw refuse();
  throw decision.reason === 'STATE'
    ? new InvalidTransitionError(`${action}: the state does not allow it`)
    : new ForbiddenError(`${action}: refused (${decision.reason})`);
}
