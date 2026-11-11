import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../common/tenancy/tenant-transaction';
import { EffectFailedForGood } from '../outbox/outbox-consumers';
import { DELIVERY } from '../queue/outbox-queue';
import { errorCodeOf } from '../queue/outbox-worker';
import {
  type MailLocale,
  MailNotSent,
  MailTransport,
  type OutgoingMail,
} from './mail-transport';
import { notSentOf } from './smtp-mail-transport';

/** How many attempts an email gets: as many as its event's job (0.7.6). */
export const MAIL_SEND_ATTEMPTS = DELIVERY.attempts;

/** An email a consumer is to send for an event, to one recipient. */
export interface EmailIntent {
  readonly eventId: string;
  /** The template's name: `invitation-notice`. */
  readonly template: string;
  /** The recipient's normalised address: kept only as its hash. */
  readonly recipient: string;
  readonly locale: MailLocale;
}

/** An email to attempt, as `dispatch` hands it to the consumer that builds it. */
export interface PendingEmail {
  readonly id: string;
  readonly template: string;
  readonly locale: MailLocale;
  /** This attempt's number, from 1. */
  readonly attempt: number;
}

/** What the consumer builds for an attempt: the message, without its envelope's bookkeeping. */
export type ComposedMail = Omit<OutgoingMail, 'messageId' | 'locale'>;

/** The hash a delivery keeps of its recipient's address. */
export function recipientHashOf(recipient: string): Buffer {
  return createHash('sha256').update(recipient).digest();
}

/**
 * Transactional email with honest delivery semantics (0.7.8). A consumer
 * records each email it is to send (`record`), on its receipt's
 * transaction, once per event and recipient; after the commit, `dispatch`
 * sends what is left, outside any transaction:
 *
 * 1. an attempt begins (SENDING, its count incremented) and commits;
 * 2. the consumer builds the message — a link's token is made now, at send
 *    time — or says nothing is wanted any more (CANCELLED);
 * 3. the server accepts it (SENT, with its Message-ID) or does not.
 *
 * A worker that stops between 1 and 3 leaves it SENDING, and the next
 * delivery sends it again: what is promised is that the intent is durable
 * and local processing happens once, not that an email arrives exactly once.
 * A failure goes back to QUEUED with its code, retried with the job's
 * back-off; the last attempt's, or a refusal of the message itself, ends it
 * FAILED — logged as an error, the alert's signal — and its event's job.
 */
export class EmailDeliveries {
  private readonly logger = new Logger('EmailDeliveries');

  constructor(
    private readonly transactions: TenantTransactions,
    private readonly transport: MailTransport,
    /** Where a Message-ID is from: the sender's domain. */
    private readonly messageIdDomain: string,
  ) {}

  /** Records `intent` on the caller's transaction; recording it again does nothing. */
  async record(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    intent: EmailIntent,
  ): Promise<void> {
    await tx.emailDelivery.createMany({
      data: [
        {
          tenantId: ctx.tenantId,
          eventId: intent.eventId,
          template: intent.template,
          recipientHash: new Uint8Array(recipientHashOf(intent.recipient)),
          locale: intent.locale,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Sends what `eventId`'s emails still need, each built by `compose`, or null if no longer wanted. */
  async dispatch(
    ctx: AuthorizedTenantContext,
    eventId: string,
    compose: (email: PendingEmail) => Promise<ComposedMail | null>,
  ): Promise<void> {
    const pending = await this.transactions.withTenantTransaction(ctx, (tx) =>
      tx.emailDelivery.findMany({
        where: {
          tenantId: ctx.tenantId,
          eventId,
          status: { in: ['QUEUED', 'SENDING'] },
        },
        select: { id: true, template: true, locale: true },
        orderBy: { id: 'asc' },
      }),
    );
    for (const email of pending) {
      await this.attempt(
        ctx,
        {
          ...email,
          locale: email.locale as MailLocale,
        },
        compose,
      );
    }
  }

  private async attempt(
    ctx: AuthorizedTenantContext,
    email: Omit<PendingEmail, 'attempt'>,
    compose: (email: PendingEmail) => Promise<ComposedMail | null>,
  ): Promise<void> {
    const [begun] = await this.transactions.withTenantTransaction(
      ctx,
      (tx) =>
        tx.$queryRaw<{ attempts: number }[]>`
        UPDATE email_deliveries
           SET status = 'SENDING', attempts = attempts + 1,
               last_attempt_at = now()
         WHERE id = ${email.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
           AND status IN ('QUEUED', 'SENDING')
        RETURNING attempts`,
    );
    if (!begun) return; // finished meanwhile
    const attempt = begun.attempts;

    let message: ComposedMail | null;
    try {
      message = await compose({ ...email, attempt });
    } catch (error) {
      // Building it failed — a database or a token's error: tried again.
      const code = errorCodeOf(error);
      if (await this.settle(ctx, email, attempt, { code, permanent: false })) {
        throw new EffectFailedForGood(code);
      }
      throw error;
    }
    if (message === null) {
      await this.transactions.withTenantTransaction(ctx, (tx) =>
        tx.emailDelivery.updateMany({
          where: { id: email.id, tenantId: ctx.tenantId, status: 'SENDING' },
          data: { status: 'CANCELLED' },
        }),
      );
      return;
    }

    const messageId = `<${email.id}.${attempt}@${this.messageIdDomain}>`;
    try {
      await this.transport.send({
        ...message,
        locale: email.locale,
        messageId,
      });
    } catch (error) {
      const notSent = error instanceof MailNotSent ? error : notSentOf(error);
      if (await this.settle(ctx, email, attempt, notSent)) {
        throw new EffectFailedForGood(notSent.code);
      }
      throw notSent;
    }
    await this.transactions.withTenantTransaction(ctx, (tx) =>
      tx.emailDelivery.updateMany({
        where: { id: email.id, tenantId: ctx.tenantId, status: 'SENDING' },
        data: { status: 'SENT', sentAt: new Date(), messageId },
      }),
    );
    this.logger.log(
      `email sent: ${email.template} ${email.id}, attempt ${attempt}`,
    );
  }

  /**
   * A failed attempt, recorded: back to QUEUED for a retry, or FAILED when
   * the failure is permanent or no attempt is left. True when FAILED.
   */
  private async settle(
    ctx: AuthorizedTenantContext,
    email: Omit<PendingEmail, 'attempt'>,
    attempt: number,
    notSent: { readonly code: string; readonly permanent: boolean },
  ): Promise<boolean> {
    const final = notSent.permanent || attempt >= MAIL_SEND_ATTEMPTS;
    await this.transactions.withTenantTransaction(ctx, (tx) =>
      tx.emailDelivery.updateMany({
        where: { id: email.id, tenantId: ctx.tenantId, status: 'SENDING' },
        data: {
          status: final ? 'FAILED' : 'QUEUED',
          lastErrorCode: notSent.code,
        },
      }),
    );
    if (final) {
      // The signal an alert on exhausted deliveries keys on (observability.md).
      this.logger.error(
        `mail.delivery_failed: ${email.template} ${email.id} failed for good, ${notSent.code} after ${attempt} attempt(s)`,
      );
    } else {
      this.logger.warn(
        `email not sent: ${email.template} ${email.id}, ${notSent.code} on attempt ${attempt}; it is tried again`,
      );
    }
    return final;
  }
}
