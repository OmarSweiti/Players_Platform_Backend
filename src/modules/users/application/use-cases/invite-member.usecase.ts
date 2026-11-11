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
import { AuditService } from '../../../../infrastructure/audit/audit.service';
import { Outbox } from '../../../../infrastructure/outbox/outbox';
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
 * The provider then sends its own setup email to an account with something
 * left to set up — verifying the address, choosing a password — before the
 * invitation is written (0.7.8): a refusal there writes nothing, and a retry
 * finds the account and asks again.
 *
 * The invitation is open for seven days, and has no token yet: its notice
 * is enqueued with it, in its transaction (`invitation.created`, the
 * invitation's id only), and the worker makes the token when it sends the
 * notice (0.7.8; InvitationNoticeConsumer). An expired invitation to the
 * same address, still open, is revoked by the new one. Each change is
 * audited, without the address.
 */
@Injectable()
export class InviteMemberUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: InvitationRecords,
    private readonly provider: IdentityProviderPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: Outbox,
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
        await this.audit.record(tx, ctx, {
          action: 'invitation.revoked',
          entityId: expired.id,
          before: { status: 'expired' },
          after: { status: 'revoked' },
          reason: 'invited-again',
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
      // The address is recorded as a reference to the invitation, never as itself.
      await this.audit.record(tx, ctx, {
        action: 'invitation.created',
        entityId: invitation.id,
        after: {
          email: invitation.email,
          role: invitation.role,
          locale: invitation.locale,
          expiresAt: invitation.expiresAt,
        },
      });
      // Its notice, sent by the worker once this commits.
      await this.outbox.enqueue(tx, ctx, {
        type: 'invitation.created',
        aggregateId: invitation.id,
        refs: { invitationId: invitation.id },
        dedupKey: `invitation.created:${invitation.id}`,
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

  /**
   * The invitee's account at the provider: found, or made, never with a
   * password; then the provider's setup email, which it sends only while
   * something is left to set up.
   */
  private async accountFor(
    email: string,
    locale: Locale,
    role: UserRole,
  ): Promise<void> {
    const subject =
      (await this.provider.findAccount(email))?.subject ??
      (await this.newAccount(email, locale, role));
    await this.provider.sendSetupEmail(subject);
  }

  /** A new account, to verify its address and choose a password, and a second factor for a privileged role. */
  private async newAccount(
    email: string,
    locale: Locale,
    role: UserRole,
  ): Promise<string> {
    const actions: RequiredAction[] = [
      'VERIFY_EMAIL',
      'SET_PASSWORD',
      ...(needsSecondFactor(role) ? (['CONFIGURE_OTP'] as const) : []),
    ];
    try {
      return (await this.provider.createAccount(email, locale, actions))
        .subject;
    } catch (error) {
      // Made meanwhile, by another invitation: it exists, as wanted.
      if (!(error instanceof AccountExistsError)) throw error;
      const made = await this.provider.findAccount(email);
      if (made === null) throw error;
      return made.subject;
    }
  }
}
