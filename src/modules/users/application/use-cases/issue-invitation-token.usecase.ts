import { Inject, Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { digestOf, newSecret } from '../../../identity/domain/secrets';
import {
  InvitationRecords,
  type InvitationView,
} from '../ports/invitation-records.port';

/** A pending invitation's new token, and the invitation it opens. */
export interface IssuedInvitation {
  /**
   * The token its link carries: 256 random bits, base64url. Only its
   * SHA-256 digest is stored; the caller puts this in the email, and
   * nowhere else — no outbox payload, log or table.
   */
  readonly token: string;
  readonly invitation: InvitationView;
}

/**
 * A new single-use token for a pending invitation (0.5.10), made by its
 * email's delivery at send time (0.7.8), so that the outbox carries the
 * invitation's id and never a link. It replaces the last: a resend, or a
 * retried delivery, leaves only the newest link working. Null when the
 * invitation is not pending — accepted, revoked or expired — and nothing is
 * to be sent.
 */
@Injectable()
export class IssueInvitationToken {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: InvitationRecords,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    invitationId: string,
  ): Promise<IssuedInvitation | null> {
    const token = newSecret();
    const invitation = await this.transactions.withTenantTransaction(
      ctx,
      (tx) =>
        this.records.issueToken(
          tx,
          ctx,
          invitationId,
          digestOf(token),
          this.clock.now(),
        ),
    );
    return invitation ? { token, invitation } : null;
  }
}
