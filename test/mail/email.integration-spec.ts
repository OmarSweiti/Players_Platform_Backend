import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { Outbox } from '../../src/infrastructure/outbox/outbox';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  createMember,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';

// Transactional email (0.7.8), on two tenants, real PostgreSQL 18, as the
// runtime role. Values are synthetic.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const sha256 = (text: string) => createHash('sha256').update(text).digest();
const suffix = () => randomBytes(4).toString('hex');

/** An invitation and its `invitation.created` event, committed by `owner`: what an email is for. */
async function invitationEvent(owner: User): Promise<string> {
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
          role: 'COACH',
          locale: 'en',
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
      return event.id;
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
        await invitationEvent(owners[0]),
        await invitationEvent(owners[1]),
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
});
