import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get, Param } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type Tenant, type User, UserRole } from '@prisma/client';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RequirePermission } from '../../src/common/decorators/permissions.decorator';
import { CurrentTenantContext } from '../../src/common/decorators/tenant-context.decorator';
import { Returns } from '../../src/common/openapi/responses';
import {
  ALLOW,
  authorizeRead,
  definePolicy,
  deny,
  disclosedClasses,
} from '../../src/common/policy/policy';
import { confidential, project } from '../../src/common/policy/projection';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import { id, IdParams, instant } from '../../src/common/validation/schemas';
import { AccessAudit } from '../../src/infrastructure/audit/access-audit';
import {
  IdentityProviderPort,
  ProviderAnswerRefusedError,
} from '../../src/modules/identity/application/ports/identity-provider.port';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import {
  AUDIENCE,
  CONFIDENTIAL,
  type ConfidentialClass,
  type DataClass,
  type Fields,
  PAGE,
  PROBLEM,
  RESPONSES,
} from '../fixtures/field-classification';
import { type BootedApp, bootApp } from '../harness/app';
import { asTenant, createMember, createTenant } from '../harness/fixtures';
import {
  controllersOf,
  type Route,
  routesOf,
  withParams,
} from '../harness/routes';
import { signedInAs } from '../harness/session';

// Confidential projections (0.6.4; I-2, SR-ACL-008), checked against an
// independent classification (test/fixtures/field-classification.ts) rather
// than the code's own markers. Every route the app serves is called by every
// role in two tenants, and by someone signed out; each answer's fields — a
// success's and a problem's — are compared with the classification: every one
// must be classified, a confidential class must reach only a role the
// classification says may receive it, and someone signed out is told only
// what is public. The quarantined modules stay off, as deployed: their routes
// answer problems, and switching one on with unclassified fields fails here.
//
// No route the app serves carries a confidential field yet: the first are the
// medical module's (0.6.8). So a route of the test's carries one — a clinical
// note's diagnosis — through the real mechanism: its schema's marker, the
// grant the stored role matrix gives, the note's policy, and the projection,
// released through the access audit (0.7.4) as a medical record's read is.

// ---- The test's route: a clinical note with a medical field. ----

const ClinicalNote = z.strictObject({
  id,
  recordedAt: instant,
  diagnosis: confidential('MEDICAL', z.string()),
});

interface Note {
  readonly id: string;
  readonly clinicianId: string;
  readonly recordedAt: Date;
  readonly diagnosis?: string;
}

/** Its clinician reads its diagnosis; any member the route admits reads the rest. */
const notePolicy = definePolicy<never, Note>(
  { read: () => ALLOW },
  {
    MEDICAL: (member, note) =>
      member.userId === note.clinicianId ? ALLOW : deny('UNRELATED'),
  },
);

/** The notes, by `tenantId/id`: a tenant's own only. */
const NOTES = new Map<string, Note>();

@Controller('probe/clinical-notes')
class ClinicalNoteProbe {
  constructor(private readonly modules: ModuleRef) {}

  @RequirePermission('medical.read')
  @Get(':id')
  @Returns(ClinicalNote)
  async read(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id: noteId }: IdParams,
  ): Promise<Note> {
    const note = authorizeRead(
      ctx,
      notePolicy,
      NOTES.get(`${ctx.tenantId}/${noteId}`),
      'Clinical note not found',
    );
    const granted = await this.modules
      .get(PermissionService, { strict: false })
      .grantedClasses(ctx);
    // A medical field leaves only after its access event (0.7.4).
    return this.modules
      .get(TenantTransactions, { strict: false })
      .withTenantTransaction(ctx, (tx) =>
        this.modules
          .get(AccessAudit, { strict: false })
          .release(
            tx,
            ctx,
            { action: 'medical_record.read', id: note.id },
            { schema: ClinicalNote, value: note },
            disclosedClasses(ctx, notePolicy, note, granted),
          ),
      );
  }
}

const PROBE = 'GET /api/v1/probe/clinical-notes/:id';

/** The classification, and the test route's: its diagnosis is medical. */
const CLASSIFIED: Readonly<Record<string, Fields>> = {
  ...RESPONSES,
  [PROBE]: {
    id: 'OPERATIONAL',
    recordedAt: 'OPERATIONAL',
    diagnosis: 'MEDICAL',
  },
};

// ---- The identity provider, for inviting: accounts made, nothing sent. ----

class AccountsDouble extends IdentityProviderPort {
  authorizationUrl(): Promise<URL> {
    return Promise.resolve(new URL('https://idp.agency.test/auth'));
  }
  exchange(): Promise<never> {
    return Promise.reject(new ProviderAnswerRefusedError('no sign-in here'));
  }
  verifyLogoutToken(): Promise<never> {
    return Promise.reject(new ProviderAnswerRefusedError('no logout token'));
  }
  endSessionUrl(): Promise<URL> {
    return Promise.resolve(new URL('https://idp.agency.test/logout'));
  }
  createAccount(): Promise<{ subject: string }> {
    return Promise.resolve({ subject: randomUUID() });
  }
  findAccount(): Promise<null> {
    return Promise.resolve(null);
  }
  sendSetupEmail(): Promise<void> {
    return Promise.resolve();
  }
  disableAccount(): Promise<void> {
    return Promise.resolve();
  }
}

// ---- Answers, and what the classification says of them. ----

type Role = Exclude<UserRole, 'SUPER_ADMIN'>;

/** Every tenant role; SUPER_ADMIN holds no tenant membership (0.6.7). */
const ROLES = Object.values(UserRole).filter(
  (role): role is Role => role !== 'SUPER_ADMIN',
);

interface Caller {
  readonly role: Role | 'SIGNED_OUT';
  readonly tenant: 0 | 1;
}

interface Answer {
  /** `METHOD /path`, as the classification names routes. */
  readonly route: string;
  readonly caller: Caller;
  readonly status: number;
  readonly body: unknown;
}

const keyOf = (route: Pick<Route, 'method' | 'path'>) =>
  `${route.method.toUpperCase()} ${route.path}`;
const labelOf = ({ role, tenant }: Caller) => `${role}@${tenant}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every field of a value, by path: `member.id`, `[].id`. */
function pathsOf(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => pathsOf(item, `${at}[]`));
  }
  if (isRecord(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) =>
      pathsOf(item, at ? `${at}.${key}` : key),
    );
  }
  return at ? [at] : [];
}

const join = (prefix: string, path: string) =>
  path.startsWith('[') ? `${prefix}${path}` : `${prefix}.${path}`;

/** A body, open to a test's changes. */
type Changeable = Record<string, unknown>;

interface Field {
  /** Where in the body: `data.member.id`, `page.hasMore`, `code`. */
  readonly field: string;
  /** Its class, or null where the classification names none. */
  readonly class: DataClass | null;
}

/**
 * Each field an answer carries, with its class: a problem's from PROBLEM, a
 * success's `data` from its route's entry and its page from PAGE. Anything
 * else beside them is unclassified.
 */
function fieldsOf(
  answer: Answer,
  classified: Readonly<Record<string, Fields>>,
): Field[] {
  const { body } = answer;
  if (!isRecord(body)) return [];
  const within = (fields: Fields, value: unknown, prefix: string): Field[] =>
    pathsOf(value).map((path) => ({
      field: prefix ? join(prefix, path) : path,
      class: Object.hasOwn(fields, path) ? fields[path] : null,
    }));
  if (answer.status >= 400) return within(PROBLEM, body, '');
  const { data, page, ...beside } = body;
  const route = Object.hasOwn(classified, answer.route)
    ? classified[answer.route]
    : {};
  return [
    ...within(route, data, 'data'),
    ...within(PAGE, page, 'page'),
    ...Object.keys(beside).map((field) => ({ field, class: null })),
  ];
}

/** Each field an answer carries that the classification does not name. */
function unclassifiedIn(
  answers: readonly Answer[],
  classified: Readonly<Record<string, Fields>>,
): string[] {
  const found = answers.flatMap((answer) =>
    fieldsOf(answer, classified)
      .filter((field) => field.class === null)
      .map(({ field }) => `${answer.route} ${field}`),
  );
  return [...new Set(found)].sort();
}

const isConfidential = (value: DataClass): value is ConfidentialClass =>
  (CONFIDENTIAL as readonly DataClass[]).includes(value);

/**
 * Each field an answer carried to a caller who may not receive it: a
 * confidential class to a role not `entitled` to it, or anything but a public
 * field to someone signed out.
 */
function exposedIn(
  answers: readonly Answer[],
  classified: Readonly<Record<string, Fields>>,
  entitled: (role: Role, value: ConfidentialClass) => boolean,
): string[] {
  const found = answers.flatMap((answer) => {
    const { role } = answer.caller;
    return fieldsOf(answer, classified)
      .filter(({ class: value }) =>
        value === null
          ? false
          : role === 'SIGNED_OUT'
            ? value !== 'PUBLIC'
            : isConfidential(value) && !entitled(role, value),
      )
      .map(
        ({ field }) => `${answer.route} ${field} → ${labelOf(answer.caller)}`,
      );
  });
  return [...new Set(found)].sort();
}

const suffix = () => randomBytes(4).toString('hex');
const WRITES = new Set(['post', 'put', 'patch']);
/** Routes that end the session they are called with. */
const ENDS_SESSIONS = new Set([
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/logout-all',
]);

describe('confidential fields, against the independent classification', () => {
  let booted: BootedApp;
  let tenants: [Tenant, Tenant];
  let routes: Route[];
  /** One member of each role in each tenant. */
  const members = new Map<string, User>();
  const memberOf = (role: Role, tenant: 0 | 1) =>
    members.get(`${role}@${tenant}`)!;
  /** A second medical member in each tenant, whom no note is about. */
  const colleagues: User[] = [];
  /** Which roles the stored matrix grants each audience's permission. */
  const holders = new Map<string, ReadonlySet<string>>();
  const answers: Answer[] = [];
  /** The test route's notes: in each tenant, the doctor's and the physiotherapist's. */
  const notes: Array<{ doctor: Note; physio: Note }> = [];
  /** Each member's read of the other tenant's doctor's note. */
  const crossTenant: Answer[] = [];

  const entitled = (role: Role, value: ConfidentialClass) => {
    const audience = AUDIENCE[value];
    return (
      audience !== null &&
      audience.eligible.includes(role) &&
      (holders.get(audience.permission)?.has(role) ?? false)
    );
  };

  async function ask(
    route: string,
    caller: Caller,
    request: () => PromiseLike<Response>,
  ): Promise<Answer> {
    const response = await request();
    const answer: Answer = {
      route,
      caller,
      status: response.status,
      body: response.body as unknown,
    };
    answers.push(answer);
    return answer;
  }

  /** `route`, its parameters fresh ids; a write sends an empty body. */
  function call(route: Route, headers: Record<string, string>) {
    const request = booted.http[route.method](
      withParams(route.path, () => randomUUID()),
    ).set(headers);
    return WRITES.has(route.method) ? request.send({}) : request;
  }

  const readNote = (
    caller: Caller,
    headers: Record<string, string>,
    note: Note,
  ) =>
    ask(PROBE, caller, () =>
      booted.http.get(`/api/v1/probe/clinical-notes/${note.id}`).set(headers),
    );

  beforeAll(async () => {
    booted = await bootApp({
      controllers: [ClinicalNoteProbe],
      identityProvider: new AccountsDouble(),
    });
    routes = controllersOf(booted.app)
      .flatMap(routesOf)
      // Signing out last: it ends the session the rest are called with.
      .sort(
        (x, y) =>
          Number(ENDS_SESSIONS.has(keyOf(x))) -
          Number(ENDS_SESSIONS.has(keyOf(y))),
      );
    tenants = [await createTenant(), await createTenant()];
    for (const tenant of [0, 1] as const) {
      for (const role of ROLES) {
        members.set(
          `${role}@${tenant}`,
          await createMember(tenants[tenant], role),
        );
      }
      colleagues.push(await createMember(tenants[tenant], 'MEDICAL'));
    }

    // Who holds each audience's permission, as the API reads it: the stored
    // matrix, which every tenant shares.
    for (const audience of Object.values(AUDIENCE)) {
      if (audience === null) continue;
      const grants = await asTenant(tenants[0].id, (tx) =>
        tx.rolePermission.findMany({
          where: { permission: { name: audience.permission } },
          select: { roleId: true },
        }),
      );
      holders.set(audience.permission, new Set(grants.map((g) => g.roleId)));
    }

    // The notes: each tenant's own, every value synthetic.
    for (const tenant of [0, 1] as const) {
      const note = (clinician: User): Note => ({
        id: randomUUID(),
        clinicianId: clinician.id,
        recordedAt: new Date('2026-11-08T09:00:00.000Z'),
        diagnosis: `Synthetic finding ${suffix()}`,
      });
      const pair = {
        doctor: note(memberOf('MEDICAL', tenant)),
        physio: note(memberOf('PHYSIOTHERAPIST', tenant)),
      };
      for (const one of [pair.doctor, pair.physio]) {
        NOTES.set(`${tenants[tenant].id}/${one.id}`, one);
      }
      notes.push(pair);
    }

    // Invitations, so that lists have some: one by each role that invites,
    // in each tenant, and one of them revoked.
    for (const tenant of [0, 1] as const) {
      for (const role of ['OWNER', 'ADMIN'] as const) {
        const headers = await signedInAs(memberOf(role, tenant));
        const invited = await ask(
          'POST /api/v1/users/invitations',
          { role, tenant },
          () =>
            booted.http
              .post('/api/v1/users/invitations')
              .set(headers)
              .send({
                email: `invitee-${suffix()}@agency.test`,
                role: 'COACH',
              }),
        );
        if (role === 'ADMIN') {
          const { id: invitationId } = (
            invited.body as { data: { id: string } }
          ).data;
          await ask(
            'DELETE /api/v1/users/invitations/:id',
            { role, tenant },
            () =>
              booted.http
                .delete(`/api/v1/users/invitations/${invitationId}`)
                .set(headers),
          );
        }
      }
    }

    // Every member reads their tenant's notes, and the other tenant's
    // doctor's note; each tenant's second medical member reads the doctor's.
    for (const tenant of [0, 1] as const) {
      const own = notes[tenant];
      const other = notes[1 - tenant];
      for (const role of ROLES) {
        const caller = { role, tenant };
        const headers = await signedInAs(memberOf(role, tenant));
        for (const note of [own.doctor, own.physio]) {
          await readNote(caller, headers, note);
        }
        crossTenant.push(await readNote(caller, headers, other.doctor));
      }
      await readNote(
        { role: 'MEDICAL', tenant },
        await signedInAs(colleagues[tenant]),
        own.doctor,
      );
    }

    // Every route, by every member and by someone signed out.
    for (const tenant of [0, 1] as const) {
      for (const role of ROLES) {
        const member = memberOf(role, tenant);
        const headers = await signedInAs(member);
        for (const route of routes) {
          await ask(keyOf(route), { role, tenant }, async () =>
            call(
              route,
              ENDS_SESSIONS.has(keyOf(route))
                ? await signedInAs(member)
                : headers,
            ),
          );
        }
      }
      const host = `${tenants[tenant].slug}.localhost`;
      for (const route of routes) {
        await ask(keyOf(route), { role: 'SIGNED_OUT', tenant }, () =>
          call(route, { Host: host, Origin: `https://${host}` }),
        );
      }
    }
  });

  afterAll(async () => {
    NOTES.clear();
    await booted?.app.close();
  });

  it('every_response_field_is_classified', () => {
    // Every route the app serves was answered.
    const answered = new Set(answers.map(({ route }) => route));
    expect(routes.map(keyOf).filter((route) => !answered.has(route))).toEqual(
      [],
    );

    // Every field of every answer is classified.
    expect(unclassifiedIn(answers, CLASSIFIED)).toEqual([]);

    // And the classification is no wider than the answers: each field it
    // names was seen in a success of its route, so none is stale.
    const seen = new Set(
      answers
        .filter(({ status }) => status < 300)
        .flatMap((answer) =>
          fieldsOf(answer, CLASSIFIED).map(
            ({ field }) => `${answer.route} ${field}`,
          ),
        ),
    );
    const named = Object.entries(CLASSIFIED).flatMap(([route, fields]) =>
      Object.keys(fields).map((path) => `${route} ${join('data', path)}`),
    );
    expect(named.filter((field) => !seen.has(field))).toEqual([]);
  });

  it('confidential_fields_are_absent_for_roles_without_permission', () => {
    // No answer carried a confidential field to a role the classification
    // does not entitle to it, nor anything but a public field to someone
    // signed out.
    expect(exposedIn(answers, CLASSIFIED, entitled)).toEqual([]);

    // And the check had something to check: a medical field was carried, to
    // the clinician whose note it is — both halves, the grant and the policy.
    const notesRead = (role: Role, tenant: 0 | 1, note: Note) =>
      answers.filter(
        (answer) =>
          answer.route === PROBE &&
          answer.caller.role === role &&
          answer.caller.tenant === tenant &&
          isRecord(answer.body) &&
          (answer.body.data as { id?: string } | undefined)?.id === note.id,
      );
    for (const tenant of [0, 1] as const) {
      const { doctor, physio } = notes[tenant];
      const [own, colleague] = notesRead('MEDICAL', tenant, doctor);
      // The doctor, who holds the grant and whose note it is: disclosed.
      expect(own.body).toEqual({
        data: {
          id: doctor.id,
          recordedAt: doctor.recordedAt.toISOString(),
          diagnosis: doctor.diagnosis,
        },
      });
      // A medical colleague holds the grant, but the policy does not
      // disclose another's note: the note, without its diagnosis.
      expect(colleague.body).toEqual({
        data: { id: doctor.id, recordedAt: doctor.recordedAt.toISOString() },
      });
      // The physiotherapist's own note: the policy would disclose it, but
      // the role holds no grant.
      const [physios] = notesRead('PHYSIOTHERAPIST', tenant, physio);
      expect(physios.body).not.toHaveProperty('data.diagnosis');
    }
    // The other tenant's note, to every member: refused by the route, or
    // not found, as absence is — never a field of it.
    expect(crossTenant).toHaveLength(ROLES.length * 2);
    expect(
      crossTenant
        .filter(({ status }) => status !== 403)
        .map(({ caller, body }) => [
          labelOf(caller),
          (body as { code?: string }).code,
        ]),
    ).toEqual(
      crossTenant
        .filter(({ status }) => status !== 403)
        .map(({ caller }) => [labelOf(caller), 'NOT_FOUND']),
    );
    expect(
      crossTenant.find(({ caller }) => caller.role === 'MEDICAL')?.status,
    ).toBe(404);
  });

  it('a_disclosed_medical_field_leaves_its_access_event', async () => {
    // Every role read every note above, in both tenants. Only the doctor's
    // own read released the diagnosis, so only it left an access event
    // (0.7.4): the clinician, their role and session, the request, and the
    // class — never the diagnosis itself.
    for (const tenant of [0, 1] as const) {
      const { doctor, physio } = notes[tenant];
      const eventsOf = (note: Note) =>
        asTenant(tenants[tenant].id, (tx) =>
          tx.auditLog.findMany({
            where: { entityId: note.id, action: 'medical_record.read' },
          }),
        );
      const [event, ...more] = await eventsOf(doctor);
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        entityType: 'MedicalRecord',
        actorType: 'USER',
        userId: doctor.clinicianId,
        actorRole: 'MEDICAL',
        actorSessionId: expect.any(String) as string,
        requestId: expect.any(String) as string,
        outcome: 'SUCCEEDED',
        newValues: { classes: ['MEDICAL'] },
      });
      expect(JSON.stringify(event)).not.toContain(doctor.diagnosis);
      expect(await eventsOf(physio)).toEqual([]);
    }
  });

  it('an_unclassified_new_field_fails_the_suite', () => {
    const successOf = (route: string) =>
      answers.find((answer) => answer.route === route && answer.status < 300)!;
    /** The answer, its body changed as the code might change it. */
    const changed = (answer: Answer, change: (body: Changeable) => void) => {
      const body = structuredClone(answer.body) as Changeable;
      change(body);
      return { ...answer, body };
    };
    const session = successOf('GET /api/v1/auth/session');
    const invitations = answers.find(
      (answer) =>
        answer.route === 'GET /api/v1/users/invitations' &&
        answer.status === 200 &&
        (answer.body as { data: unknown[] }).data.length > 0,
    )!;

    // A field the code adds; a select widened to a column no response names;
    // a route that starts to answer with a field; a key beside `data`. Each
    // is reported, where the real answers are not.
    expect(
      unclassifiedIn(
        [
          changed(session, (body) => {
            (body.data as { member: Changeable }).member.email =
              'member@agency.test';
          }),
          changed(invitations, (body) => {
            (body.data as Changeable[])[0].tokenHash = 'x';
          }),
          {
            ...session,
            route: 'DELETE /api/v1/auth/sessions/:id',
            body: { data: { id: 'x' } },
          },
          changed(session, (body) => {
            body.meta = {};
          }),
        ],
        CLASSIFIED,
      ),
    ).toEqual([
      'DELETE /api/v1/auth/sessions/:id data.id',
      'GET /api/v1/auth/session data.member.email',
      'GET /api/v1/auth/session meta',
      'GET /api/v1/users/invitations data[].tokenHash',
    ]);
    expect(unclassifiedIn([session, invitations], CLASSIFIED)).toEqual([]);

    // A marker the code loses: the note's schema without it, projected for
    // a physiotherapist, carries the diagnosis — and is reported.
    const unmarked = ClinicalNote.extend({ diagnosis: z.string() });
    const note = notes[0].physio;
    expect(
      exposedIn(
        [
          {
            route: PROBE,
            caller: { role: 'PHYSIOTHERAPIST', tenant: 0 },
            status: 200,
            body: JSON.parse(
              JSON.stringify({ data: project(unmarked, note, new Set()) }),
            ) as unknown,
          },
        ],
        CLASSIFIED,
        entitled,
      ),
    ).toEqual([`${PROBE} data.diagnosis → PHYSIOTHERAPIST@0`]);
  });
});
