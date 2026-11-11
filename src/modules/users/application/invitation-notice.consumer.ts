import { Inject, Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../common/time/clock';
import {
  type ComposedMail,
  EmailDeliveries,
  type PendingEmail,
} from '../../../infrastructure/mail/email-deliveries';
import {
  MAIL_LINKS,
  type MailLinks,
} from '../../../infrastructure/mail/mail.module';
import {
  INVITATION_NOTICE,
  invitationNotice,
} from '../../../infrastructure/mail/templates/invitation-notice';
import {
  type DeliveredEvent,
  OutboxConsumer,
} from '../../../infrastructure/outbox/outbox-consumers';
import { normalizeEmail } from '../domain/email';
import { statusOf } from '../domain/invitation';
import { InvitationRecords } from './ports/invitation-records.port';
import { IssueInvitationToken } from './use-cases/issue-invitation-token.usecase';

/** Where an invitation's link accepts it: sign-in, with its token (0.5.10). */
const ACCEPT_PATH = '/api/v1/auth/login';

/**
 * The invitation's notice (0.7.8), the first consumer of the outbox. When an
 * invitation is created, its event's receipt records one email to the
 * invitee, in the invitation's language — if it is still pending. After the
 * commit, the email is sent: its token is made then, at send time, and only
 * its digest kept (IssueInvitationToken), so the outbox carries the
 * invitation's id and never a link. An invitation no longer pending by then
 * — accepted, revoked, expired — is sent nothing.
 */
@Injectable()
export class InvitationNoticeConsumer extends OutboxConsumer {
  readonly name = 'mail.invitation-notice';
  readonly types = ['invitation.created'] as const;

  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: InvitationRecords,
    private readonly issueToken: IssueInvitationToken,
    private readonly emails: EmailDeliveries,
    @Inject(MAIL_LINKS) private readonly links: MailLinks,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async consume(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    event: DeliveredEvent,
  ): Promise<string | undefined> {
    const invitation = await this.records.find(
      tx,
      ctx,
      event.payloadRefs.invitationId,
    );
    if (
      invitation === null ||
      statusOf(invitation, this.clock.now()) !== 'pending'
    ) {
      return undefined;
    }
    await this.emails.record(tx, ctx, {
      eventId: event.id,
      template: INVITATION_NOTICE,
      recipient: normalizeEmail(invitation.email),
      locale: invitation.locale,
    });
    return invitation.id;
  }

  dispatch(ctx: AuthorizedTenantContext, event: DeliveredEvent): Promise<void> {
    return this.emails.dispatch(ctx, event.id, (email) =>
      this.compose(ctx, event.payloadRefs.invitationId, email),
    );
  }

  /** The notice for this attempt, with a new token; null once the invitation is no longer pending. */
  private async compose(
    ctx: AuthorizedTenantContext,
    invitationId: string,
    email: PendingEmail,
  ): Promise<ComposedMail | null> {
    const issued = await this.issueToken.execute(ctx, invitationId);
    if (issued === null) return null;
    const agency = await this.transactions.withTenantTransaction(ctx, (tx) =>
      this.records.agencyOf(tx, ctx),
    );
    const host = agency.domain ?? `${agency.slug}.${this.links.apexDomain}`;
    const link = new URL(ACCEPT_PATH, `https://${host}`);
    link.searchParams.set('invitation', issued.token);
    return {
      to: issued.invitation.email,
      ...invitationNotice(email.locale, {
        agency: agency.name,
        role: issued.invitation.role,
        link: link.toString(),
        expiresAt: issued.invitation.expiresAt,
        timeZone: agency.timezone,
      }),
    };
  }
}
