import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Tenant } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Env, EventImportEnv } from '../../src/config/env.schema';
import { SecurityEvents } from '../../src/infrastructure/audit/security-events';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import type { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { ProviderAnswerRefusedError } from '../../src/modules/identity/application/ports/identity-provider.port';
import { SignInAttempts } from '../../src/modules/identity/application/ports/sign-in-attempts.port';
import { ImportProviderSecurityEventsUseCase } from '../../src/modules/identity/application/use-cases/import-provider-security-events.usecase';
import { KeycloakProviderSecurityEvents } from '../../src/modules/identity/infrastructure/keycloak/keycloak-provider-security-events';
import { bootApp, type BootedApp } from '../harness/app';
import { createTenant, runPrisma } from '../harness/fixtures';
import { TestIssuer } from '../support/test-issuer';

// Security events that have no tenant (0.7.3; SR-AUD-001, DB-33, DB-61),
// against PostgreSQL 18, as the runtime role and as the owner, with two
// tenants. The table is evidence, insert-only for the runtime role; a refused
// sign-in on a host that names no tenant is recorded without one, and on a
// tenant's host with that tenant as its hint; the identity provider's own
// sign-in failures are imported through its adapter — from an issuer in this
// process that answers as Keycloak's admin API does — redacted, and once.

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const PREAUTH = '__Host-Http-sadara_preauth';
const ISSUER = 'https://idp.agency.test/realms/sadara';

type Outcome = { rowCount: number } | { code?: string; message: string };

/** One row of the table, as the owner reads it. */
interface Row {
  source: string;
  event_type: string;
  outcome: string;
  reason_code: string | null;
  tenant_hint: string | null;
  issuer: string | null;
  subject: string | null;
  session_id: string | null;
  request_id: string | null;
  network_hash: Buffer | null;
  provider_event_id: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
}

const suffix = () => randomBytes(4).toString('hex');

/** The keyed hash an address is kept as, under the test environment's key. */
const hashOf = (address: string) =>
  createHmac('sha256', process.env.SECURITY_EVENT_KEY ?? '')
    .update(`sadara.security-event.network\n${address}`)
    .digest();

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

/** `sql` in a transaction of its own, rolled back: what it wrote, or why it was refused. */
async function attempt(
  client: Client,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Outcome> {
  await client.query('BEGIN');
  try {
    const { rowCount } = await client.query(sql, [...params]);
    return { rowCount: rowCount ?? 0 };
  } catch (error) {
    const { code, message } = error as DatabaseError;
    return { code, message };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** The service, writing as the runtime role. */
function securityEvents(): SecurityEvents {
  return new SecurityEvents(
    runPrisma() as unknown as PrismaService,
    {
      get: () => process.env.SECURITY_EVENT_KEY,
    } as unknown as ConfigService<Env, true>,
  );
}

describe('security events', () => {
  let app: Client;
  let owner: Client;
  let a: Tenant;
  let b: Tenant;

  /** The rows `where` selects, as the owner reads them. */
  async function rowsWhere(
    where: string,
    params: readonly unknown[],
  ): Promise<Row[]> {
    const { rows } = await owner.query<Row>(
      `SELECT * FROM security_events WHERE ${where} ORDER BY occurred_at, provider_event_id`,
      [...params],
    );
    return rows;
  }

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    owner = await connect(inject('migrationDatabaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
  });

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
  });

  it('acts as the runtime role and as the owner', async () => {
    const roleOf = async (client: Client) =>
      (await client.query<{ role: string }>('SELECT current_user AS role'))
        .rows[0].role;
    expect([await roleOf(app), await roleOf(owner)]).toEqual([
      'sadara_app',
      'sadara_owner',
    ]);
  });

  it('security_events_are_append_only', async () => {
    // Written through the typed adapter, as the runtime role, which may not
    // read the table: one event of each tenant's, and one of none.
    const events = securityEvents();
    const requestId = randomUUID();
    for (const tenantHint of [a.id, b.id, null]) {
      await events.record(
        {
          type: 'sign_out',
          outcome: 'SUCCEEDED',
          tenantHint,
          sessionId: randomUUID(),
          metadata: { revoked: 1 },
        },
        { requestId, client: { address: '198.51.100.20' } },
      );
    }
    const evidence = async () =>
      (
        await owner.query<{ digest: string; rows: number }>(
          `SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS digest, count(*)::int AS rows
             FROM security_events t WHERE request_id = $1`,
          [requestId],
        )
      ).rows[0];
    const before = await evidence();
    expect(before.rows).toBe(3);

    // The runtime role adds rows, and reads, changes and removes none.
    const denied = expect.objectContaining({
      code: INSUFFICIENT_PRIVILEGE,
      message: 'permission denied for table security_events',
    }) as unknown;
    expect(
      await attempt(
        app,
        `INSERT INTO security_events (id, source, event_type, outcome) VALUES ($1, 'SADARA', 'sign_in', 'SUCCEEDED')`,
        [randomUUID()],
      ),
    ).toEqual({ rowCount: 1 });
    for (const sql of [
      'SELECT id FROM security_events',
      `UPDATE security_events SET outcome = 'REFUSED', reason_code = 'x' WHERE request_id = $1`,
      'DELETE FROM security_events WHERE request_id = $1',
      'TRUNCATE security_events',
    ]) {
      const params = sql.includes('$1') ? [requestId] : [];
      expect([sql, await attempt(app, sql, params)]).toEqual([sql, denied]);
    }

    // Nor does the owner: the triggers refuse every role.
    const appendOnly = (operation: string) =>
      expect.objectContaining({
        code: INSUFFICIENT_PRIVILEGE,
        message: `evidence is append-only: ${operation} on security_events is refused`,
      }) as unknown;
    expect(
      await attempt(
        owner,
        `UPDATE security_events SET tenant_hint = NULL WHERE request_id = $1`,
        [requestId],
      ),
    ).toEqual(appendOnly('UPDATE'));
    expect(
      await attempt(
        owner,
        'DELETE FROM security_events WHERE request_id = $1',
        [requestId],
      ),
    ).toEqual(appendOnly('DELETE'));
    expect(await attempt(owner, 'TRUNCATE security_events')).toEqual(
      appendOnly('TRUNCATE'),
    );
    expect(await evidence()).toEqual(before);

    // The grants and the triggers, as the catalog holds them.
    const { rows: grants } = await owner.query<{ privilege: string }>(
      `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
        WHERE table_schema = current_schema() AND table_name = 'security_events'
          AND grantee = 'sadara_app' ORDER BY 1`,
    );
    expect(grants).toEqual([{ privilege: 'INSERT' }]);
    const { rows: triggers } = await owner.query<{
      name: string;
      definition: string;
      enabled: string;
    }>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition, tgenabled AS enabled
         FROM pg_trigger
        WHERE tgrelid = 'security_events'::regclass AND NOT tgisinternal
        ORDER BY 1`,
    );
    expect(triggers).toEqual([
      {
        name: 'security_events_no_truncate',
        definition: expect.stringMatching(
          /BEFORE TRUNCATE ON \S*security_events FOR EACH STATEMENT EXECUTE FUNCTION \S*reject_evidence_mutation\(\)$/,
        ) as unknown,
        enabled: 'O',
      },
      {
        name: 'security_events_no_update_delete',
        definition: expect.stringMatching(
          /BEFORE DELETE OR UPDATE ON \S*security_events FOR EACH ROW EXECUTE FUNCTION \S*reject_evidence_mutation\(\)$/,
        ) as unknown,
        enabled: 'O',
      },
    ]);
  });

  it('a_row_holds_only_what_its_checks_allow', async () => {
    // Each CHECK refuses its counter-example, and a row that keeps them all
    // is taken (as the owner, rolled back).
    const insert = (values: Record<string, unknown>) => {
      const row = {
        id: randomUUID(),
        source: 'SADARA',
        event_type: 'sign_in',
        outcome: 'SUCCEEDED',
        ...values,
      };
      const columns = Object.keys(row);
      return attempt(
        owner,
        `INSERT INTO security_events (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    const refusedBy = (constraint: string) =>
      expect.objectContaining({
        code: CHECK_VIOLATION,
        message: expect.stringContaining(constraint) as unknown,
      }) as unknown;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['security_events_event_type_check', { event_type: 'Sign In' }],
      ['security_events_event_type_check', { event_type: 'sign_in.' }],
      [
        'security_events_reason_code_check',
        { outcome: 'REFUSED', reason_code: 'Owner@Agency.test' },
      ],
      ['security_events_refusal_check', { outcome: 'REFUSED' }],
      ['security_events_source_check', { provider_event_id: 'login:1' }],
      ['security_events_source_check', { source: 'PROVIDER' }],
      [
        'security_events_provider_event_id_check',
        { source: 'PROVIDER', provider_event_id: 'login:a b' },
      ],
      ['security_events_identity_check', { subject: 'sub-1' }],
      [
        'security_events_network_hash_check',
        { network_hash: Buffer.alloc(16) },
      ],
      ['security_events_metadata_check', { metadata: '[1]' }],
      [
        'security_events_metadata_check',
        { metadata: JSON.stringify({ note: 'x'.repeat(4100) }) },
      ],
    ];
    for (const [constraint, values] of cases) {
      expect([constraint, values, await insert(values)]).toEqual([
        constraint,
        values,
        refusedBy(constraint),
      ]);
    }
    expect(
      await insert({
        source: 'PROVIDER',
        event_type: 'provider.login_error',
        outcome: 'REFUSED',
        reason_code: 'invalid_user_credentials',
        provider_event_id: `login:${randomUUID()}`,
        issuer: ISSUER,
        network_hash: hashOf('203.0.113.1'),
        metadata: JSON.stringify({ clientId: 'sadara-api' }),
      }),
    ).toEqual({ rowCount: 1 });
  });

  describe('sign-in, through the API', () => {
    let booted: BootedApp;
    let addresses = 0;

    beforeAll(async () => {
      booted = await bootApp({ trustedProxies: ['loopback'] });
    });

    afterAll(async () => {
      await booted?.app.close();
    });

    /** A callback as a browser brings it back, from an address of its own. */
    async function callback(
      host: string,
      state: string,
      preauth: string = randomBytes(32).toString('base64url'),
    ) {
      const address = `192.0.2.${(addresses += 1)}`;
      const response = await booted.http
        .get(`/api/v1/auth/callback?code=${suffix()}&state=${state}`)
        .set('Host', host)
        .set('X-Forwarded-For', address)
        .set('Cookie', `${PREAUTH}=${preauth}`)
        .redirects(0);
      return {
        response,
        address,
        requestId: response.headers['x-request-id'],
      };
    }

    it('a_refused_sign_in_is_recorded_without_a_tenant', async () => {
      // A sign-in begun on the first tenant's host comes back on a host that
      // names no tenant: refused there, and recorded without a tenant — none
      // is invented, not even the one it began on.
      const preauth = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      await booted.app.get(SignInAttempts, { strict: false }).keep(
        state,
        {
          tenantId: a.id,
          redirectUri: `https://${a.slug}.localhost/api/v1/auth/callback`,
          returnTo: '/',
          nonce: randomBytes(32).toString('base64url'),
          codeVerifier: randomBytes(32).toString('base64url'),
          browserBinding: createHash('sha256')
            .update(preauth)
            .digest('base64url'),
        },
        600,
      );
      const unknown = await callback(
        `nowhere-${suffix()}.localhost`,
        state,
        preauth,
      );
      expect(unknown.response.status).toBe(404);
      expect(await rowsWhere('request_id = $1', [unknown.requestId])).toEqual([
        {
          source: 'SADARA',
          event_type: 'sign_in',
          outcome: 'REFUSED',
          reason_code: 'no_account',
          tenant_hint: null,
          issuer: null,
          subject: null,
          session_id: null,
          request_id: unknown.requestId,
          network_hash: hashOf(unknown.address),
          provider_event_id: null,
          metadata: null,
          occurred_at: expect.any(Date) as Date,
          id: expect.any(String) as string,
          recorded_at: expect.any(Date) as Date,
        },
      ]);

      // On a tenant's own host, the refusal has that tenant as its hint —
      // each tenant's, in two tenants — and the address only as its hash.
      for (const tenant of [a, b]) {
        const refused = await callback(
          `${tenant.slug}.localhost`,
          randomBytes(32).toString('base64url'),
        );
        expect(refused.response.status).toBe(401);
        const [row] = await rowsWhere('request_id = $1', [refused.requestId]);
        expect(row).toMatchObject({
          event_type: 'sign_in',
          outcome: 'REFUSED',
          reason_code: 'state',
          tenant_hint: tenant.id,
          network_hash: hashOf(refused.address),
        });
        const { rows } = await owner.query<{ found: boolean }>(
          `SELECT EXISTS (SELECT FROM security_events t
                           WHERE request_id = $1 AND t::text LIKE '%' || $2 || '%') AS found`,
          [refused.requestId, refused.address],
        );
        expect(rows).toEqual([{ found: false }]);
      }
    });
  });

  describe("the identity provider's own events", () => {
    let issuer: TestIssuer;
    const now = Date.now();
    const at = (minutesAgo: number) => now - minutesAgo * 60_000;
    const realmId = randomUUID();
    const member = randomUUID();
    const typed = 'member@agency.test';

    /** The import, through the adapter as the event reader, as the runtime role. */
    function importer(clientSecret = issuer.eventReaderSecret) {
      const env: Partial<EventImportEnv> = {
        OIDC_ISSUER: issuer.issuer,
        OIDC_EVENTS_CLIENT_ID: issuer.eventReaderId,
        OIDC_EVENTS_CLIENT_SECRET: clientSecret,
      };
      const provider = new KeycloakProviderSecurityEvents({
        get: (name: keyof EventImportEnv) => env[name],
      } as unknown as ConfigService<EventImportEnv, true>);
      return new ImportProviderSecurityEventsUseCase(
        provider,
        securityEvents(),
      );
    }

    beforeAll(async () => {
      issuer = await TestIssuer.start();
      // Keycloak's own shape, details and representation included, which
      // hold what a person typed and must never be imported.
      issuer.events.login.push(
        {
          id: randomUUID(),
          time: at(30),
          type: 'LOGIN_ERROR',
          realmId,
          clientId: 'sadara-api',
          userId: member,
          ipAddress: '203.0.113.50',
          error: 'invalid_user_credentials',
          details: { username: typed, auth_method: 'openid-connect' },
        },
        {
          id: randomUUID(),
          time: at(29),
          type: 'LOGIN_ERROR',
          realmId,
          clientId: 'sadara-api',
          ipAddress: '203.0.113.51',
          error: 'user_not_found',
          details: { username: 'someone-else@agency.test' },
        },
        {
          id: randomUUID(),
          time: at(28),
          type: 'LOGIN_ERROR',
          realmId,
          // In a client id's own form: only the provider's verdict keeps it out.
          clientId: 'a-client-someone-typed',
          ipAddress: '203.0.113.52',
          error: 'client_not_found',
        },
        {
          id: randomUUID(),
          time: at(27),
          type: 'UPDATE_TOTP',
          realmId,
          clientId: 'account-console',
          userId: member,
          sessionId: randomUUID(),
          ipAddress: '203.0.113.50',
          details: { username: typed },
        },
        // Out of form: no id. Read, and not imported.
        { time: at(26), type: 'LOGIN', realmId },
        // Before the window: never read.
        { id: randomUUID(), time: at(60 * 48), type: 'LOGIN', realmId },
      );
      issuer.events.admin.push({
        id: randomUUID(),
        time: at(25),
        realmId,
        operationType: 'CREATE',
        resourceType: 'USER',
        resourcePath: `users/${randomUUID()}`,
        representation: JSON.stringify({ email: 'invitee@agency.test' }),
        authDetails: {
          realmId,
          clientId: 'sadara-admin',
          userId: randomUUID(),
          ipAddress: '198.51.100.9',
        },
      });
    });

    afterAll(async () => {
      await issuer?.close();
    });

    it('provider_sign_in_failures_reach_security_events', async () => {
      const report = await importer().execute({
        since: new Date(at(60 * 24)),
        limit: 1000,
      });
      expect(report).toEqual({
        since: new Date(at(60 * 24)).toISOString(),
        read: 5,
        imported: 5,
        alreadyKept: 0,
        unreadable: 1,
        complete: true,
      });

      const [wrongPassword, unknownUser, unknownClient, totp] =
        issuer.events.login;
      const [created] = issuer.events.admin;
      // This file's events only: the run's schema is shared with every
      // integration file, the import command's among them.
      const ids = [...issuer.events.login, ...issuer.events.admin].map(
        (event) =>
          `${'operationType' in event ? 'admin' : 'login'}:${String(event.id)}`,
      );
      const rows = await rowsWhere('provider_event_id = ANY($1)', [ids]);
      const common = {
        source: 'PROVIDER',
        tenant_hint: null,
        session_id: null,
        request_id: null,
      };
      expect(rows).toEqual([
        // A wrong password: refused, its subject named, its address hashed.
        expect.objectContaining({
          ...common,
          provider_event_id: `login:${wrongPassword.id as string}`,
          event_type: 'provider.login_error',
          outcome: 'REFUSED',
          reason_code: 'invalid_user_credentials',
          issuer: issuer.issuer,
          subject: member,
          network_hash: hashOf('203.0.113.50'),
          metadata: { clientId: 'sadara-api' },
          occurred_at: new Date(wrongPassword.time),
        }),
        // An unknown user: refused, and nobody named — never what was typed.
        expect.objectContaining({
          ...common,
          provider_event_id: `login:${unknownUser.id as string}`,
          outcome: 'REFUSED',
          reason_code: 'user_not_found',
          issuer: null,
          subject: null,
          network_hash: hashOf('203.0.113.51'),
        }),
        // A client the provider did not find: its name is not kept.
        expect.objectContaining({
          provider_event_id: `login:${unknownClient.id as string}`,
          reason_code: 'client_not_found',
          metadata: {},
        }),
        // A second factor changed: the MFA change SR-AUD-001 asks for.
        expect.objectContaining({
          provider_event_id: `login:${totp.id as string}`,
          event_type: 'provider.update_totp',
          outcome: 'SUCCEEDED',
          reason_code: null,
          subject: member,
          metadata: {
            clientId: 'account-console',
            providerSessionId: totp.sessionId,
          },
        }),
        // An account made at the provider, by the API's service account.
        expect.objectContaining({
          ...common,
          provider_event_id: `admin:${created.id as string}`,
          event_type: 'provider.admin.user.create',
          outcome: 'SUCCEEDED',
          subject: (created.authDetails as { userId: string }).userId,
          network_hash: hashOf('198.51.100.9'),
          metadata: {
            clientId: 'sadara-admin',
            resourcePath: created.resourcePath,
          },
        }),
      ]);
      // Nothing a person typed, and no address, reached the table.
      const kept = JSON.stringify(rows);
      for (const value of [
        typed,
        'someone-else@agency.test',
        'invitee@agency.test',
        'a-client-someone-typed',
        '203.0.113.5',
        '198.51.100.9',
      ]) {
        expect([value, kept.includes(value)]).toEqual([value, false]);
      }

      // Imported again, or in a window that overlaps: nothing twice.
      expect(
        await importer().execute({ since: new Date(at(60)), limit: 1000 }),
      ).toMatchObject({ read: 5, imported: 0, alreadyKept: 5 });
      expect(
        await rowsWhere('provider_event_id = ANY($1)', [ids]),
      ).toHaveLength(5);
    });

    it('reads_the_providers_events_a_page_at_a_time_within_its_bound', async () => {
      const window = new Date(at(60 * 24));
      const many = Array.from({ length: 150 }, (_, i) => ({
        id: randomUUID(),
        time: at(20) + i,
        type: 'LOGIN',
        realmId,
        userId: member,
      }));
      issuer.events.login.push(...many);
      issuer.eventReads.length = 0;

      // A bound below the window's events: the newest only, and said so.
      expect(
        await importer().execute({ since: window, limit: 120 }),
      ).toMatchObject({ read: 120 + 1, complete: false });
      expect(issuer.eventReads).toEqual([
        `login?dateFrom=${window.getTime()}&first=0&max=100`,
        `login?dateFrom=${window.getTime()}&first=100&max=20`,
        `admin?dateFrom=${window.getTime()}&first=0&max=100`,
      ]);

      // A bound above them: every event, page by page, the rest imported.
      expect(
        await importer().execute({ since: window, limit: 1000 }),
      ).toMatchObject({ read: 155, imported: 30, complete: true });

      // Only the event reader is answered: another secret gets no token.
      await expect(
        importer('not-the-readers-secret').execute({
          since: window,
          limit: 10,
        }),
      ).rejects.toMatchObject({
        constructor: ProviderAnswerRefusedError,
        check: expect.stringMatching(/:invalid_client$/) as unknown,
      });
    });
  });
});
