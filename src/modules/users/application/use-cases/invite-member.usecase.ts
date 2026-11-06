import { Inject, Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import {
  ConflictError,
  ForbiddenError,
} from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { needsSecondFactor } from '../../../identity/application/assurance.policy';
import {
  AccountExistsError,
  IdentityProviderPort,
  type Locale,
  type RequiredAction,
} from '../../../identity/application/ports/identity-provider.port';
import { normalizeEmail } from '../../domain/email';
import { INVITATION_LIFETIME_MS, statusOf } from '../../domain/invitation';
import {
  InvitationRecords,
  type ListedInvitation,
} from '../ports/invitation-records.port';
import { mayGrant } from '../role-grants.policy';

export interface Invite {
  readonly email: string;
  readonly role: UserRole;
  /** The language of the invitation's email: the tenant's default if unsaid. */
  readonly locale?: Locale;
}

/**
 * Inviting a person to the tenant, with a role (0.5.10; ADR-0002). A member
 * may grant only a role their own allows (role-grants.policy.ts), to an
 * address no member holds and no pending invitation names; both are checked
 * before the identity provider is touched, and again as the invitation is
 * written. The invitee's provider account is found, or made with the actions
 * that have them verify their address, choose a password and, for a
 * privileged role, set up a second factor (0.5.8): never with a password.
 *
 * The invitation is open for seven days, and has no token yet: its email's
 * delivery makes one when it sends it (0.7.8; IssueInvitationToken). An
 * expired invitation to the same address, still open, is revoked by the new
 * one. Each change is audited, without the address.
 */
@Injectable()
export class InviteMemberUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: InvitationRecords,
    private readonly provider: IdentityProviderPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    input: Invite,
  ): Promise<ListedInvitation> {
    const inviterId = actingMemberOf(ctx);
    const email = input.email.trim();
    const normalizedEmail = normalizeEmail(email);
    const at = () => this.clock.now();

    const locale = await this.transactions.withTenantTransaction(
      ctx,
      async (tx) => {
        await this.admissible(
          tx,
          ctx,
          inviterId,
          input.role,
          normalizedEmail,
          at(),
        );
        return input.locale ?? (await this.records.tenantLocale(tx, ctx));
      },
    );

    await this.accountFor(email.toLowerCase(), locale, input.role);

    return this.transactions.withTenantTransaction(ctx, async (tx) => {
      const now = at();
      const expired = await this.admissible(
        tx,
        ctx,
        inviterId,
        input.role,
        normalizedEmail,
        now,
      );
      if (expired && (await this.records.revoke(tx, ctx, expired.id, now))) {
        await this.records.audit(tx, ctx, {
          action: 'invitation.revoked',
          invitationId: expired.id,
          oldValues: { status: 'expired' },
          newValues: { status: 'revoked', reason: 'invited-again' },
        });
      }
      const invitation = await this.records.create(tx, ctx, {
        email,
        normalizedEmail,
        role: input.role,
        locale,
        invitedById: inviterId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
      });
      await this.records.audit(tx, ctx, {
        action: 'invitation.created',
        invitationId: invitation.id,
        newValues: {
          role: invitation.role,
          locale: invitation.locale,
          expiresAt: invitation.expiresAt.toISOString(),
        },
      });
      return { ...invitation, status: statusOf(invitation, now) };
    });
  }

  /**
   * The inviter may grant the role, no member holds the address and no
   * pending invitation names it; an expired one still open, to replace, if
   * there is one.
   */
  private async admissible(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    inviterId: string,
    role: UserRole,
    normalizedEmail: string,
    at: Date,
  ): Promise<{ id: string } | null> {
    const own = await this.records.activeRoleOf(tx, ctx, inviterId);
    if (own === null || !mayGrant(own, role)) {
      throw new ForbiddenError('the inviter may not grant this role');
    }
    if (await this.records.isMemberAddress(tx, ctx, normalizedEmail)) {
      throw new ConflictError('a member of the tenant holds this address');
    }
    const open = await this.records.openTo(tx, ctx, normalizedEmail);
    if (open && open.expiresAt > at) {
      throw new ConflictError('a pending invitation names this address');
    }
    return open;
  }

  /** The invitee's account at the provider: found, or made, never with a password. */
  private async accountFor(
    email: string,
    locale: Locale,
    role: UserRole,
  ): Promise<void> {
    if (await this.provider.findAccount(email)) return;
    const actions: RequiredAction[] = [
      'VERIFY_EMAIL',
      'SET_PASSWORD',
      ...(needsSecondFactor(role) ? (['CONFIGURE_OTP'] as const) : []),
    ];
    try {
      await this.provider.createAccount(email, locale, actions);
    } catch (error) {
      // Made meanwhile, by another invitation: it exists, as wanted.
      if (!(error instanceof AccountExistsError)) throw error;
    }
  }
}
