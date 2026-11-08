import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { ForbiddenError } from '../errors/domain-error';

// The tenant a piece of work runs for (0.4.3; ADR-0004). It is never read
// from a request: a context is minted only by the session guard (0.5.6), the
// worker's job loader (0.7.6) or an audited platform operation, and only they
// may import `mintTenantContext` (eslint.config.mjs). Everything else receives
// a context and passes it on.

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Branded<string, 'TenantId'>;
export type UserId = Branded<string, 'UserId'>;
export type SessionId = Branded<string, 'SessionId'>;

/**
 * Who acts: a signed-in member, or the system doing a job — never an invented
 * account. PLATFORM arrives in 4.1. A member acts in their role in this
 * tenant, as their membership held it when the context was minted: object
 * policies decide from it (0.6.3), so a use case called directly is decided
 * as one called over HTTP is.
 */
export type Actor =
  | {
      readonly kind: 'USER';
      readonly userId: UserId;
      readonly sessionId: SessionId;
      readonly role: UserRole;
    }
  | { readonly kind: 'SYSTEM'; readonly job: string };

declare const minted: unique symbol;

/** A context only `mintTenantContext` makes: an object literal, a copy or a parsed body is not one. */
export type AuthorizedTenantContext = Readonly<{
  tenantId: TenantId;
  actor: Actor;
  requestId: string;
  locale: 'ar' | 'en';
}> & { readonly [minted]: true };

const Fields = z.strictObject({
  tenantId: z.uuid(),
  actor: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('USER'),
      userId: z.uuid(),
      sessionId: z.uuid(),
      role: z.enum(UserRole),
    }),
    z.strictObject({
      kind: z.literal('SYSTEM'),
      job: z.string().min(1).max(100),
    }),
  ]),
  requestId: z.string().min(1).max(128),
  locale: z.enum(['ar', 'en']),
});
export type TenantContextFields = z.input<typeof Fields>;

/** Thrown when work is handed something that is not a minted context. */
export class TenantContextRefused extends Error {
  constructor() {
    super(
      'not an authorized tenant context: one is minted only by the session guard, the job loader or an audited platform operation',
    );
    this.name = 'TenantContextRefused';
  }
}

// Identity, not shape: a copy or a reconstruction of a minted context is not in here.
const mintedContexts = new WeakSet<object>();

/**
 * Makes a context from fields its caller has already verified — the session's
 * member, the job's tenant. Only the minters named above may import this.
 */
export function mintTenantContext(
  fields: TenantContextFields,
): AuthorizedTenantContext {
  const checked = Fields.parse(fields);
  const context = Object.freeze({
    ...checked,
    actor: Object.freeze({ ...checked.actor }),
  }) as unknown as AuthorizedTenantContext;
  mintedContexts.add(context);
  return context;
}

export function isAuthorizedTenantContext(
  value: unknown,
): value is AuthorizedTenantContext {
  return (
    typeof value === 'object' && value !== null && mintedContexts.has(value)
  );
}

export function assertAuthorizedTenantContext(
  value: unknown,
): asserts value is AuthorizedTenantContext {
  if (!isAuthorizedTenantContext(value)) throw new TenantContextRefused();
}

/**
 * The member a context acts for: a job is not a member, so work that records
 * who did it (a report's scout, a record's author) refuses one.
 */
export function actingMemberOf(ctx: AuthorizedTenantContext): UserId {
  if (ctx.actor.kind !== 'USER') {
    throw new ForbiddenError('Only a signed-in member can do this');
  }
  return ctx.actor.userId;
}
