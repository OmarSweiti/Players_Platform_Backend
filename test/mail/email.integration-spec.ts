import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Locale, Tenant, User, UserRole } from '@prisma/client';
import type { Job } from 'bullmq';
import { Client, type DatabaseError } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { systemClock } from '../../src/common/time/clock';
import {
  EmailDeliveries,
  MAIL_SEND_ATTEMPTS,
} from '../../src/infrastructure/mail/email-deliveries';
import { MailNotSent } from '../../src/infrastructure/mail/mail-transport';
import { SmtpMailTransport } from '../../src/infrastructure/mail/smtp-mail-transport';
import { ConsumerInboxes } from '../../src/infrastructure/outbox/consumer-inboxes';
import { Outbox } from '../../src/infrastructure/outbox/outbox';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  JobFailedForGood,
  OutboxJobHandler,
} from '../../src/infrastructure/queue/outbox-worker';
import { InvitationNoticeConsumer } from '../../src/modules/users/application/invitation-notice.consumer';
import { IssueInvitationToken } from '../../src/modules/users/application/use-cases/issue-invitation-token.usecase';
import { InvitationRepository } from '../../src/modules/users/infrastructure/repositories/invitation.repository';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';
import { headerOf, partOf, SmtpSink } from '../support/smtp-sink';

// Transactional email (0.7.8), on two tenants, real PostgreSQL 18, as the
// runtime role. The invitation's notice runs as the worker runs it — its
// event's job, through the outbox handler, its receipt, then its dispatch —
// over SMTP to a server in this process (test/support/smtp-sink.ts), which
// can refuse a message as a real one might. Values are synthetic.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const sha256 = (text: string) => createHash('sha256').update(text).digest();
const suffix = () => randomBytes(4).toString('hex');

interface Invited {
  readonly invitationId: string;
  readonly eventId: string;
  readonly email: string;
}

/** An invitation and its `invitation.created` event, committed by `owner`, as inviting commits them. */
async function invited(
  owner: User,
  { locale = 'en', role = 'COACH' }: { locale?: Locale; role?: UserRole } = {},
): Promise<Invited> {
  const ctx = memberContext(owner);
  return new TenantTransactions(runPrisma()).withTenantTransaction(
    ctx,
    async (tx) => {
      const email = `invitee-${suffix()}@agency.test`;
      const { id } = await tx.invitation.create({
        data: {
          tenantId: owner.tenantId,
          email,
          normalizedEmail: email,
          role,
          locale,
          invitedById: owner.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        },
        select: { id: true },
      });
      const event = await new Outbox().enqueue(tx, ctx, {
        type: 'invitation.created',
        aggregateId: id,
        refs: { invitationId: id },
        dedupKey: `invitation.created:${id}`,
      });
      return { invitationId: id, eventId: event.id, email };
    },
  );
}

describe('transactional email', () => {
  let tenants: Tenant[];
  let owners: User[];

  beforeAll(async () => {
    tenants = [await createTenant(), await createTenant()];
    owners = [
      await createMember(tenants[0], 'OWNER'),
      await createMember(tenants[1], 'OWNER'),
    ];
  });

  describe('the email delivery, as the database holds it', () => {
    let app: Client;
    let events: string[];

    beforeAll(async () => {
      events = [
        (await invited(owners[0])).eventId,
        (await invited(owners[1])).eventId,
      ];
      const { connectionString, options } = databaseConnectionOf(
        inject('databaseUrl'),
      );
      app = new Client({ connectionString, options });
      await app.connect();
    });

    afterAll(async () => {
      await app?.end();
    });

    /** Deliveries written straight, as `tenant`, rolled back: or why they were refused. */
    async function insert(
      tenant: Tenant,
      ...rows: Record<string, unknown>[]
    ): Promise<'written' | { code: string; constraint?: string }> {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant.id,
        ]);
        for (const values of rows) {
          const row = {
            tenant_id: tenant.id,
            event_id: events[tenants.indexOf(tenant)],
            template: 'invitation-notice',
            recipient_hash: sha256(`invitee-${randomUUID()}@agency.test`),
            locale: 'ar',
            ...values,
          };
          const columns = Object.keys(row);
          await app.query(
            `INSERT INTO email_deliveries (id, ${columns.join(', ')})
             VALUES (uuidv7(), ${columns.map((_, n) => `$${n + 1}`).join(', ')})`,
            Object.values(row),
          );
        }
        return 'written';
      } catch (error) {
        const { code, constraint } = error as DatabaseError;
        return { code: code ?? '', constraint };
      } finally {
        await app.query('ROLLBACK');
      }
    }

    it('an_email_delivery_holds_only_what_its_checks_allow', async () => {
      const [tenant] = tenants;
      const at = new Date();
      const sent = {
        status: 'SENT',
        attempts: 1,
        last_attempt_at: at,
        sent_at: at,
        message_id: `<${randomUUID()}.1@sadara.test>`,
      };
      const cases: Array<[string, Record<string, unknown>]> = [
        ['email_deliveries_template_check', { template: 'Invitation_Notice' }],
        ['email_deliveries_template_check', { template: 'invitation-' }],
        [
          'email_deliveries_recipient_hash_check',
          { recipient_hash: Buffer.alloc(31) },
        ],
        ['email_deliveries_locale_check', { locale: 'fr' }],
        ['email_deliveries_attempts_check', { attempts: -1 }],
        // An attempt's time comes with the first attempt, and only then.
        ['email_deliveries_attempts_check', { attempts: 1 }],
        ['email_deliveries_attempts_check', { last_attempt_at: at }],
        // Sending, sent or failed: attempted.
        ['email_deliveries_attempts_check', { status: 'SENDING' }],
        // A time and a Message-ID exactly when sent.
        ['email_deliveries_sent_check', { ...sent, sent_at: null }],
        ['email_deliveries_sent_check', { ...sent, message_id: null }],
        [
          'email_deliveries_sent_check',
          { ...sent, status: 'SENDING', message_id: null },
        ],
        ['email_deliveries_message_id_check', { ...sent, message_id: 'id-1' }],
        [
          'email_deliveries_message_id_check',
          { ...sent, message_id: '<two words@sadara.test>' },
        ],
        [
          'email_deliveries_failed_check',
          { status: 'FAILED', attempts: 8, last_attempt_at: at },
        ],
      ];
      for (const [constraint, values] of cases) {
        expect([constraint, values, await insert(tenant, values)]).toEqual([
          constraint,
          values,
          { code: CHECK_VIOLATION, constraint },
        ]);
      }

      // A row in each state keeps them all.
      for (const values of [
        {},
        {
          locale: 'en',
          attempts: 2,
          last_attempt_at: at,
          last_error_code: 'smtp_451',
        },
        { status: 'SENDING', attempts: 1, last_attempt_at: at },
        sent,
        {
          status: 'FAILED',
          attempts: 8,
          last_attempt_at: at,
          last_error_code: 'smtp_550',
        },
        { status: 'CANCELLED' },
      ]) {
        expect([values, await insert(tenant, values)]).toEqual([
          values,
          'written',
        ]);
      }
    });

    it('an_email_is_recorded_once_per_event_and_recipient', async () => {
      const [tenant, other] = tenants;
      const recipient = sha256(`invitee-${randomUUID()}@agency.test`);
      expect(
        await insert(
          tenant,
          { recipient_hash: recipient },
          { recipient_hash: recipient, template: 'another-notice' },
        ),
      ).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'email_deliveries_event_recipient_key',
      });
      // Another tenant's event, from this tenant: refused by the key that
      // carries the tenant.
      expect(await insert(tenant, { event_id: events[1] })).toEqual({
        code: FOREIGN_KEY_VIOLATION,
        constraint: 'email_deliveries_event_id_tenant_id_fkey',
      });
      // The same recipient for the other tenant's own event: its own record.
      expect(await insert(other, { recipient_hash: recipient })).toBe(
        'written',
      );
    });
  });

  describe('the invitation notice', () => {
    let sink: SmtpSink;
    let transport: SmtpMailTransport;
    let handler: OutboxJobHandler;
    let consumer: InvitationNoticeConsumer;
    const transactions = () => new TenantTransactions(runPrisma());
    const tokens = () =>
      new IssueInvitationToken(
        transactions(),
        new InvitationRepository(),
        systemClock,
      );
    const logger = { runInContext: <T>(fn: () => T) => fn() };

    beforeAll(async () => {
      sink = await SmtpSink.start();
      transport = new SmtpMailTransport({
        host: '127.0.0.1',
        port: sink.port,
        tls: 'none',
        from: 'no-reply@sadara.test',
      });
      consumer = new InvitationNoticeConsumer(
        transactions(),
        new InvitationRepository(),
        tokens(),
        new EmailDeliveries(transactions(), transport, 'sadara.test'),
        { apexDomain: 'localhost' },
        systemClock,
      );
      handler = new OutboxJobHandler(
        runPrisma(),
        new ConsumerInboxes(),
        [consumer],
        logger,
      );
      // The Arabic-speaking tenant: an Arabic name, a zone of its own.
      await asTenant(tenants[0].id, (tx) =>
        tx.tenant.update({
          where: { id: tenants[0].id },
          data: { name: 'وكالة الاختبار الرياضية', timezone: 'Asia/Amman' },
        }),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await transport?.close();
      await sink?.close();
    });

    /** The event's job, run as the worker runs it. */
    const deliver = (owner: User, { eventId }: Invited) =>
      handler.handle({
        id: eventId,
        data: {
          tenantId: owner.tenantId,
          eventId,
          correlation: { requestId: null },
        },
        attemptsMade: 0,
      } as unknown as Job);

    /** What the sink accepted for `email`, in order. */
    const mailTo = (email: string) =>
      sink.received.filter((mail) => mail.to.includes(email));

    /** The token a notice's link carries. */
    const tokenIn = (raw: string) =>
      /invitation=([A-Za-z0-9_-]+)/.exec(partOf(raw, 'text/plain'))?.[1] ?? '';

    const deliveriesOf = (owner: User, { eventId }: Invited) =>
      asTenant(owner.tenantId, (tx) =>
        tx.emailDelivery.findMany({ where: { eventId } }),
      );

    const tokenHashOf = (owner: User, { invitationId }: Invited) =>
      asTenant(owner.tenantId, (tx) =>
        tx.invitation
          .findUniqueOrThrow({
            where: { id: invitationId },
            select: { tokenHash: true },
          })
          .then(({ tokenHash }) =>
            tokenHash ? Buffer.from(tokenHash).toString('hex') : null,
          ),
      );

    it('an_invitation_notice_is_sent_in_the_recipients_locale', async () => {
      const [sadara, northwind] = owners;
      const arabic = await invited(sadara, { locale: 'ar', role: 'COACH' });
      const english = await invited(northwind, {
        locale: 'en',
        role: 'SCOUT',
      });
      expect(await deliver(sadara, arabic)).toBe(1);
      expect(await deliver(northwind, english)).toBe(1);

      // Arabic, right to left, from صدارة, its agency's name isolated.
      const [ar] = mailTo(arabic.email);
      expect(ar.from).toBe('no-reply@sadara.test');
      expect(headerOf(ar.raw, 'Subject')).toBe(
        'دعوة للانضمام إلى \u2068وكالة الاختبار الرياضية\u2069 على صدارة',
      );
      expect(headerOf(ar.raw, 'From')).toContain('صدارة');
      expect(headerOf(ar.raw, 'Auto-Submitted')).toBe('auto-generated');
      expect(partOf(ar.raw, 'text/plain')).toContain('بدور المدرب');
      expect(partOf(ar.raw, 'text/html')).toContain(
        '<html lang="ar" dir="rtl">',
      );
      // The link: sign-in on the tenant's own host, with a token whose
      // digest alone the invitation keeps.
      expect(partOf(ar.raw, 'text/plain')).toContain(
        `https://${tenants[0].slug}.localhost/api/v1/auth/login?invitation=`,
      );
      const token = tokenIn(ar.raw);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await tokenHashOf(sadara, arabic)).toBe(
        sha256(token).toString('hex'),
      );

      // English, left to right, from Sadara.
      const [en] = mailTo(english.email);
      expect(headerOf(en.raw, 'Subject')).toBe(
        `Test agency ${tenants[1].slug} invites you to Sadara`,
      );
      expect(headerOf(en.raw, 'From')).toContain('Sadara');
      expect(partOf(en.raw, 'text/plain')).toContain('with the role of Scout');
      expect(partOf(en.raw, 'text/html')).toContain(
        '<html lang="en" dir="ltr">',
      );

      // Each recorded as sent, once, in its own tenant: the recipient a
      // hash, the Message-ID the one sent, no address and no token.
      for (const [owner, invite, mail, locale] of [
        [sadara, arabic, ar, 'ar'],
        [northwind, english, en, 'en'],
      ] as const) {
        const [delivery] = await deliveriesOf(owner, invite);
        expect(delivery).toMatchObject({
          template: 'invitation-notice',
          locale,
          status: 'SENT',
          attempts: 1,
          lastErrorCode: null,
          messageId: `<${delivery.id}.1@sadara.test>`,
        });
        expect(headerOf(mail.raw, 'Message-ID')).toBe(delivery.messageId);
        expect(Buffer.from(delivery.recipientHash)).toEqual(
          sha256(invite.email),
        );
        const rows = JSON.stringify([
          delivery,
          await asTenant(owner.tenantId, (tx) =>
            tx.outboxEvent.findUniqueOrThrow({ where: { id: invite.eventId } }),
          ),
          await asTenant(owner.tenantId, (tx) =>
            tx.consumerInbox.findMany({ where: { eventId: invite.eventId } }),
          ),
        ]);
        expect(rows).not.toContain(invite.email);
        expect(rows).not.toContain(tokenIn(mail.raw));
      }
      // Neither tenant reads the other's deliveries.
      expect(
        await asTenant(tenants[0].id, (tx) =>
          tx.emailDelivery.count({ where: { tenantId: tenants[1].id } }),
        ),
      ).toBe(0);
    });

    it('a_redelivered_event_does_not_resend_a_recorded_email', async () => {
      const [sadara] = owners;
      const invite = await invited(sadara, { locale: 'ar' });
      await deliver(sadara, invite);
      const token = tokenIn(mailTo(invite.email)[0].raw);
      // Delivered again, and twice at once: nothing more is sent.
      await deliver(sadara, invite);
      await Promise.all([deliver(sadara, invite), deliver(sadara, invite)]);
      expect(mailTo(invite.email)).toHaveLength(1);
      const [delivery] = await deliveriesOf(sadara, invite);
      expect(delivery).toMatchObject({ status: 'SENT', attempts: 1 });
      // Its link still works: no new token replaced it.
      expect(await tokenHashOf(sadara, invite)).toBe(
        sha256(token).toString('hex'),
      );
      expect(
        await asTenant(sadara.tenantId, (tx) =>
          tx.consumerInbox.count({ where: { eventId: invite.eventId } }),
        ),
      ).toBe(1);
    });

    it('a_worker_that_stops_after_the_server_accepted_sends_again', async () => {
      const [sadara] = owners;
      const invite = await invited(sadara);
      await deliver(sadara, invite);
      const first = tokenIn(mailTo(invite.email)[0].raw);
      // As a worker that stopped after the server accepted the message,
      // before recording it, leaves the delivery.
      await asTenant(sadara.tenantId, (tx) =>
        tx.emailDelivery.updateMany({
          where: { eventId: invite.eventId },
          data: { status: 'SENDING', sentAt: null, messageId: null },
        }),
      );
      await deliver(sadara, invite);
      // Sent again — the duplicate the design admits — as attempt 2, with a
      // new link; only the newest works.
      const sent = mailTo(invite.email);
      expect(sent).toHaveLength(2);
      const [delivery] = await deliveriesOf(sadara, invite);
      expect(delivery).toMatchObject({
        status: 'SENT',
        attempts: 2,
        messageId: `<${delivery.id}.2@sadara.test>`,
      });
      const second = tokenIn(sent[1].raw);
      expect(second).not.toBe(first);
      expect(await tokenHashOf(sadara, invite)).toBe(
        sha256(second).toString('hex'),
      );
    });

    it('a_refused_message_is_retried_to_its_bound_then_fails_for_good', async () => {
      const [, northwind] = owners;
      const failed = vi.spyOn(Logger.prototype, 'error');

      // Refused for now: recorded, and retried by the job.
      const later = await invited(northwind);
      sink.refuseNext('451 4.3.0 Try again later');
      await expect(deliver(northwind, later)).rejects.toMatchObject({
        code: 'smtp_451',
      });
      expect((await deliveriesOf(northwind, later))[0]).toMatchObject({
        status: 'QUEUED',
        attempts: 1,
        lastErrorCode: 'smtp_451',
      });
      await deliver(northwind, later);
      expect(mailTo(later.email)).toHaveLength(1);
      expect((await deliveriesOf(northwind, later))[0]).toMatchObject({
        status: 'SENT',
        attempts: 2,
      });

      // Refused for good: FAILED at once, the job ended, never sent again.
      const refused = await invited(northwind);
      sink.refuseNext('550 5.1.1 No such mailbox');
      const ended = await deliver(northwind, refused).then(
        () => expect.unreachable(),
        (error: unknown) => error,
      );
      expect(ended).toBeInstanceOf(JobFailedForGood);
      expect(ended).toMatchObject({ code: 'smtp_550' });
      await deliver(northwind, refused);
      expect(mailTo(refused.email)).toHaveLength(0);
      expect((await deliveriesOf(northwind, refused))[0]).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastErrorCode: 'smtp_550',
      });

      // Refused for now, every time: FAILED after the last attempt.
      const bounded = await invited(northwind);
      for (let attempt = 1; attempt <= MAIL_SEND_ATTEMPTS; attempt += 1) {
        sink.refuseNext('421 4.7.0 Too busy');
        const error = await deliver(northwind, bounded).then(
          () => expect.unreachable(),
          (failure: unknown) => failure,
        );
        expect([attempt, error instanceof JobFailedForGood]).toEqual([
          attempt,
          attempt === MAIL_SEND_ATTEMPTS,
        ]);
        if (attempt < MAIL_SEND_ATTEMPTS) {
          expect(error).toBeInstanceOf(MailNotSent);
        }
      }
      expect((await deliveriesOf(northwind, bounded))[0]).toMatchObject({
        status: 'FAILED',
        attempts: MAIL_SEND_ATTEMPTS,
        lastErrorCode: 'smtp_421',
      });
      // Each FAILED email is logged as the alert's signal, without its address.
      const lines = failed.mock.calls.map(([line]) => String(line));
      expect(
        lines.filter((line) => line.startsWith('mail.delivery_failed:')),
      ).toHaveLength(2);
      expect(lines.join('\n')).not.toContain('@agency.test');
    });

    it('an_invitation_no_longer_pending_is_sent_nothing', async () => {
      const [sadara] = owners;
      const revoke = ({ invitationId }: Invited) =>
        asTenant(sadara.tenantId, (tx) =>
          tx.invitation.update({
            where: { id: invitationId },
            data: { revokedAt: new Date() },
          }),
        );
      // Revoked before its event was delivered: no email is recorded.
      const early = await invited(sadara);
      await revoke(early);
      await deliver(sadara, early);
      expect(await deliveriesOf(sadara, early)).toEqual([]);

      // Revoked after its email was recorded, before it was sent: cancelled.
      const late = await invited(sadara);
      sink.refuseNext('451 4.3.0 Try again later');
      await deliver(sadara, late).catch(() => undefined);
      await revoke(late);
      await deliver(sadara, late);
      expect((await deliveriesOf(sadara, late))[0]).toMatchObject({
        status: 'CANCELLED',
      });
      expect(mailTo(early.email)).toHaveLength(0);
      expect(mailTo(late.email)).toHaveLength(0);
    });
  });
});
