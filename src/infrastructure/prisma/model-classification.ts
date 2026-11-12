import { Prisma } from '@prisma/client';

/**
 * What the runtime role may do with a global table, chosen table by table.
 *
 * - `own-tenant-row`: the tenants table. Row-level security shows and accepts
 *   only the row of the tenant in `app.tenant_id`; host resolution and job
 *   discovery read the narrow `tenant_directory` view instead.
 * - `read-only`: reference data the migrations write (permissions, the default
 *   role matrix, the currencies). The runtime role may read it and change nothing.
 * - `append-only`: identities (0.5.3). The runtime role reads them and adds one
 *   when a person first joins a tenant, and never rewrites or removes one: an
 *   issuer and a subject name a person for good.
 * - `insert-only`: security events (0.7.3), evidence of no one tenant's. The
 *   runtime role adds them and reads none: reading is a security operator's.
 *   As for `appended` rows, triggers refuse UPDATE, DELETE and TRUNCATE for
 *   every role, the owner included.
 */
export type GlobalAccess =
  'own-tenant-row' | 'read-only' | 'append-only' | 'insert-only';

/**
 * How a model's ids are made (0.4.11; SR-DB-002). UUIDv4 unless the class
 * says `time-ordered`: an append-heavy table whose index locality matters
 * (audit logs, security events, the outbox and inbox, sessions, messages,
 * notifications) takes UUIDv7 from `@default(uuid(7))`, declared when its
 * table is created or rebuilt. Prisma makes the id, so a raw INSERT supplies
 * its own; existing ids never change. test/db/ids.integration-spec.ts holds
 * every model's `@default` to its class.
 */
interface Ids {
  readonly ids?: 'time-ordered';
}

/**
 * What becomes of a tenant's rows. Changed and removed unless the class says
 * otherwise:
 * - `kept`: a record closed by a state of its own and never removed — an
 *   invitation (0.5.10) is accepted or revoked, and the list shows each — so
 *   the runtime role may not delete one.
 * - `appended`: evidence, written once and never changed or removed (0.7.1;
 *   SR-AUD-005). The runtime role inserts and reads; triggers refuse UPDATE,
 *   DELETE and TRUNCATE for every role, the owner included.
 * - `contained`: a legacy table its owning step migrates and retires — no new
 *   writes, its rows kept (0.8.2). The runtime role reads it and writes
 *   nothing; a migration may still write it, as the owner.
 */
interface Rows {
  readonly rows?: 'kept' | 'appended' | 'contained';
}

export type ModelClass =
  /**
   * One tenant's rows, by `tenant_id`: forced row-level security with the
   * tenant policy, and a `tenant_id` that never changes.
   */
  | ({ readonly kind: 'tenant-owned' } & Ids & Rows)
  /** No tenant's alone: no `tenant_id`, and the runtime role's access is `runtime`. */
  | ({ readonly kind: 'global'; readonly runtime: GlobalAccess } & Ids);

const TENANT_OWNED = { kind: 'tenant-owned' } as const;

/**
 * Every Prisma model, classified once (0.4.5; ADR-0004). The type refuses an
 * unclassified model at compile time; test/db/rls.integration-spec.ts refuses
 * one at run time, a model whose `tenantId` disagrees with its class, and any
 * table with a `tenant_id` column that lacks its policy. A new model enters
 * here in the migration that creates its table, and scripts/generate-rls.ts
 * writes that table's policy, trigger and grants from this entry.
 */
export const MODEL_CLASSIFICATION: Readonly<
  Record<Prisma.ModelName, ModelClass>
> = {
  Tenant: { kind: 'global', runtime: 'own-tenant-row' },
  Permission: { kind: 'global', runtime: 'read-only' },
  RolePermission: { kind: 'global', runtime: 'read-only' },
  CurrencyDefinition: { kind: 'global', runtime: 'read-only' },
  Identity: { kind: 'global', runtime: 'append-only' },
  // Appended on every sign-in, never updated: its index grows at one end.
  SecurityEvent: {
    kind: 'global',
    runtime: 'insert-only',
    ids: 'time-ordered',
  },

  User: TENANT_OWNED,
  // A row per sign-in, rarely updated: its index grows at one end.
  UserSession: { ...TENANT_OWNED, ids: 'time-ordered' },
  // Accepted or revoked, never removed: the list shows what became of each.
  Invitation: { ...TENANT_OWNED, rows: 'kept' },
  Season: TENANT_OWNED,
  // Polymorphic, with no referential integrity: contained until 1.3.1
  // migrates its rows to file objects and retires it (0.8.2).
  Document: { ...TENANT_OWNED, rows: 'contained' },
  Player: TENANT_OWNED,
  PlayerMedia: TENANT_OWNED,
  MedicalRecord: TENANT_OWNED,
  Contract: TENANT_OWNED,
  ContractVersion: TENANT_OWNED,
  ContractApproval: TENANT_OWNED,
  PerformanceRecord: TENANT_OWNED,
  Rating: TENANT_OWNED,
  Training: TENANT_OWNED,
  TrainingSession: TENANT_OWNED,
  Enrollment: TENANT_OWNED,
  Attendance: TENANT_OWNED,
  LegalTicket: TENANT_OWNED,
  LegalNote: TENANT_OWNED,
  Conversation: TENANT_OWNED,
  ConversationMember: TENANT_OWNED,
  ScoutingReport: TENANT_OWNED,
  PlayerWatchlist: TENANT_OWNED,
  ScoutingAssignment: TENANT_OWNED,
  TreatmentSession: TENANT_OWNED,
  Message: TENANT_OWNED,
  Notification: TENANT_OWNED,
  // Appended on every change, never updated: its index grows at one end.
  AuditLog: { ...TENANT_OWNED, ids: 'time-ordered', rows: 'appended' },
  // Written with each change that has an effect after it, and kept: its status
  // moves through delivery, and nothing removes an event still needed (0.7.5).
  OutboxEvent: { ...TENANT_OWNED, ids: 'time-ordered', rows: 'kept' },
  // A consumer's receipt, kept for as long as its event may be redelivered.
  ConsumerInbox: { ...TENANT_OWNED, ids: 'time-ordered', rows: 'kept' },
  // One per retried command, claimed and then finished in place (0.7.7). An
  // expired record answers nothing, and its key may be claimed afresh: the
  // runtime role removes it then, so it is not kept.
  IdempotencyRecord: { ...TENANT_OWNED, ids: 'time-ordered' },
  // An email an event's consumer sends, kept as the record that it was sent,
  // failed, or was no longer wanted (0.7.8).
  EmailDelivery: { ...TENANT_OWNED, ids: 'time-ordered', rows: 'kept' },
  // A file and its upload (0.8.2): each closed by a state of its own; a file
  // is purged by marking it, never removed (1.3.4).
  FileObject: { ...TENANT_OWNED, rows: 'kept' },
  UploadSession: { ...TENANT_OWNED, rows: 'kept' },
};

/** A model as the database knows it: its table, and the column that names its tenant. */
export interface ClassifiedTable {
  model: Prisma.ModelName;
  table: string;
  class: ModelClass;
  /** `tenant_id` on a tenant-owned table; `id` on the tenants table itself; null otherwise. */
  tenantColumn: string | null;
}

/** Every classified model with its table, in the schema's order. */
export function classifiedTables(): ClassifiedTable[] {
  return Prisma.dmmf.datamodel.models.map((model) => {
    const name = model.name as Prisma.ModelName;
    const modelClass = MODEL_CLASSIFICATION[name];
    if (!modelClass) {
      throw new Error(`model ${model.name} is not in MODEL_CLASSIFICATION`);
    }
    const tenantColumn =
      modelClass.kind === 'tenant-owned'
        ? 'tenant_id'
        : modelClass.runtime === 'own-tenant-row'
          ? 'id'
          : null;
    return {
      model: name,
      table: model.dbName ?? model.name,
      class: modelClass,
      tenantColumn,
    };
  });
}
