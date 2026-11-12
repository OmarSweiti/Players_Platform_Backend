import { createHash, randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { newObjectKey } from '../../src/infrastructure/storage/object-keys';
import {
  asContainedTableOwner,
  asTenant,
  createMember,
  createPlayer,
  createTenant,
  testContext,
} from '../harness/fixtures';

// File objects and upload sessions (0.8.2; ADR-0009, SR-DOC-001,
// SR-DB-008), as the database holds them: on two tenants, as the runtime
// role. A file is a row, never a URL; its keys are its builder's, under its
// own tenant; its size is a 64-bit integer; once pinned, its identity never
// changes; an upload names its owner without joining it; and the legacy
// documents table takes no new writes. Values are synthetic.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const INTEGRITY_VIOLATION = '23000';
const INSUFFICIENT_PRIVILEGE = '42501';
const GIB = 1024n ** 3n;

const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** The legacy columns that name a file by URL, each with the step that retires it (domain-workflows.md). */
const LEGACY_URL_COLUMNS = [
  'contract_versions.file_url', // 1.4.8
  'contracts.file_url', // 1.4.1
  'conversations.image_url', // 2.6.2
  'documents.file_url', // 1.3.1
  'messages.file_url', // 2.6.5
  'player_media.file_url', // 1.3.3
  'tenants.logo_url', // 1.1.2
  'users.avatar_url', // 1.1.8
];

describe('file objects and upload sessions', () => {
  let app: Client;
  let tenants: Tenant[];
  let members: User[];

  beforeAll(async () => {
    tenants = [await createTenant(), await createTenant()];
    members = [
      await createMember(tenants[0], 'ADMIN'),
      await createMember(tenants[1], 'ADMIN'),
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

  const keyOf = (tenant: Tenant, area: 'quarantine' | 'objects') =>
    newObjectKey(testContext(tenant.id), area);

  /** A file row as the runtime role writes one, every required column filled. */
  const fileRow = (member: User, values: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    tenant_id: member.tenantId,
    quarantine_key: keyOf(
      tenants.find((t) => t.id === member.tenantId)!,
      'quarantine',
    ),
    size_bytes: '1024',
    mime_type: 'application/pdf',
    original_name: 'عقد اللاعب.pdf',
    classification: 'OPERATIONAL',
    created_by_id: member.id,
    ...values,
  });

  /** Statements as `member`'s tenant, in one transaction, rolled back: what the last returned, or why one failed. */
  async function as(
    member: User,
    statements: Array<[string, unknown[]]>,
  ): Promise<
    | { rows: Record<string, unknown>[] }
    | { code: string; constraint?: string; message?: string }
  > {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [
        member.tenantId,
      ]);
      let rows: Record<string, unknown>[] = [];
      for (const [sql, params] of statements) {
        rows = (await app.query<Record<string, unknown>>(sql, params)).rows;
      }
      return { rows };
    } catch (error) {
      const { code, constraint, message } = error as DatabaseError;
      return { code: code ?? '', constraint, message };
    } finally {
      await app.query('ROLLBACK');
    }
  }

  const insertFile = (row: Record<string, unknown>): [string, unknown[]] => {
    const columns = Object.keys(row);
    return [
      `INSERT INTO file_objects (${columns.join(', ')})
       VALUES (${columns.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    ];
  };

  const outcome = async (member: User, row: Record<string, unknown>) => {
    const result = await as(member, [insertFile(row)]);
    return 'rows' in result
      ? 'written'
      : { code: result.code, constraint: result.constraint };
  };

  it('a_file_object_never_stores_a_url', async () => {
    const [a, b] = members;
    // Its keys are its builder's, under its own tenant: never a URL, a name,
    // or another tenant's.
    for (const [constraint, values] of [
      [
        'file_objects_quarantine_key_check',
        { quarantine_key: 'https://objects.agency.test/contract.pdf' },
      ],
      [
        'file_objects_quarantine_key_check',
        { quarantine_key: `tenants/${a.tenantId}/quarantine/contract.pdf` },
      ],
      [
        'file_objects_quarantine_key_check',
        { quarantine_key: keyOf(tenants[1], 'quarantine') },
      ],
      [
        'file_objects_quarantine_key_check',
        { quarantine_key: keyOf(tenants[0], 'objects') },
      ],
      [
        'file_objects_object_key_check',
        {
          object_key: 'https://objects.agency.test/a',
          object_version_id: 'v1',
          sha256: sha256('a'),
          scan_verdict: 'CLEAN',
          scanned_at: new Date(),
        },
      ],
      [
        'file_objects_object_key_check',
        {
          object_key: keyOf(tenants[0], 'quarantine'),
          object_version_id: 'v1',
          sha256: sha256('a'),
          scan_verdict: 'CLEAN',
          scanned_at: new Date(),
        },
      ],
    ] as const) {
      expect([constraint, await outcome(a, fileRow(a, values))]).toEqual([
        constraint,
        { code: CHECK_VIOLATION, constraint },
      ]);
    }
    expect(await outcome(a, fileRow(a))).toBe('written');
    expect(await outcome(b, fileRow(b))).toBe('written');

    // Neither table has a column for a URL, and the schema's columns that
    // name a file by URL are the legacy ones their owning steps retire.
    const { rows } = await app.query<{ column: string }>(
      `SELECT table_name || '.' || column_name AS column
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name ~ '(^|_)(url|uri|link|href)$'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.column)).toEqual(LEGACY_URL_COLUMNS);
  });

  it('sizes_beyond_two_gibibytes_are_representable', async () => {
    const [a] = members;
    // Past 2 GiB, past 4 GiB, and past JavaScript's safe integers: exact.
    const sizes = [2n * GIB + 1n, 5n * GIB, 2n ** 53n + 1n];
    const read = await asTenant(a.tenantId, async (tx) => {
      const made = [];
      for (const sizeBytes of sizes) {
        const file = await tx.fileObject.create({
          data: {
            tenantId: a.tenantId,
            quarantineKey: keyOf(tenants[0], 'quarantine'),
            sizeBytes,
            mimeType: 'video/mp4',
            originalName: 'match-highlights.mp4',
            classification: 'OPERATIONAL',
            createdById: a.id,
          },
          select: { id: true },
        });
        await tx.uploadSession.create({
          data: {
            tenantId: a.tenantId,
            fileObjectId: file.id,
            createdById: a.id,
            declaredSize: sizeBytes,
            declaredType: 'video/mp4',
            ownerKind: 'player-media',
            ownerId: randomUUID(),
            expiresAt: new Date(Date.now() + 15 * 60_000),
          },
        });
        made.push(file.id);
      }
      return tx.fileObject.findMany({
        where: { id: { in: made } },
        select: {
          sizeBytes: true,
          uploadSessions: { select: { declaredSize: true } },
        },
      });
    });
    expect(read.map((f) => f.sizeBytes).sort()).toEqual([...sizes].sort());
    expect(read.map((f) => f.uploadSessions[0].declaredSize).sort()).toEqual(
      [...sizes].sort(),
    );
    // In SQL too, and a column of 64 bits.
    const { rows } = await app.query<{ type: string }>(
      `SELECT data_type AS type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (('file_objects', 'size_bytes'), ('upload_sessions', 'declared_size'))`,
    );
    expect(rows.map((r) => r.type)).toEqual(['bigint', 'bigint']);
  });

  it('a_file_object_holds_only_what_its_checks_allow', async () => {
    const [a] = members;
    const at = new Date();
    // A verdict has its time (0.8.4).
    const clean = {
      object_key: keyOf(tenants[0], 'objects'),
      object_version_id: 'v-object',
      sha256: sha256('bytes'),
      scan_verdict: 'CLEAN',
      scanned_at: at,
      quarantine_version_id: 'v-quarantine',
    };
    const infected = {
      status: 'REJECTED',
      quarantine_version_id: 'v-1',
      scan_verdict: 'INFECTED',
      scanned_at: at,
      scan_finding: 'Eicar-Test-Signature',
    };
    for (const [constraint, values] of [
      ['file_objects_object_check', { ...clean, object_version_id: null }],
      [
        'file_objects_version_ids_check',
        { quarantine_version_id: 'two words' },
      ],
      ['file_objects_version_ids_check', { quarantine_version_id: '' }],
      ['file_objects_sha256_check', { ...clean, sha256: Buffer.alloc(16) }],
      ['file_objects_size_bytes_check', { size_bytes: '0' }],
      ['file_objects_mime_type_check', { mime_type: 'PDF' }],
      ['file_objects_mime_type_check', { mime_type: 'Application/PDF' }],
      ['file_objects_original_name_check', { original_name: '' }],
      ['file_objects_original_name_check', { original_name: 'report\n.pdf' }],
      ['file_objects_retention_class_check', { retention_class: 'forever' }],
      // Pinned from UPLOADED on.
      ['file_objects_pinned_check', { status: 'UPLOADED' }],
      // Promoted only when clean, and hashed.
      [
        'file_objects_promoted_check',
        { ...clean, scan_verdict: 'PENDING', scanned_at: null },
      ],
      ['file_objects_promoted_check', { ...clean, sha256: null }],
      // READY only clean, promoted, and finalized; finalized only READY.
      ['file_objects_ready_check', { ...clean, status: 'READY' }],
      [
        'file_objects_ready_check',
        {
          quarantine_version_id: 'v',
          status: 'READY',
          scan_verdict: 'CLEAN',
          scanned_at: at,
          finalized_at: at,
        },
      ],
      ['file_objects_ready_check', { finalized_at: at }],
      // INFECTED only REJECTED.
      ['file_objects_infected_check', { ...infected, status: 'SCANNING' }],
      // The scan's record (0.8.4): a verdict has its time, PENDING none.
      ['file_objects_scanned_check', { ...clean, scanned_at: null }],
      ['file_objects_scanned_check', { scanned_at: at }],
      // A finding is an infected file's, in printable characters.
      ['file_objects_scan_finding_check', { ...infected, scan_finding: null }],
      [
        'file_objects_scan_finding_check',
        {
          status: 'FAILED',
          scan_verdict: 'ERROR',
          scanned_at: at,
          scan_finding: 'Eicar-Test-Signature',
        },
      ],
      [
        'file_objects_scan_finding_check',
        { ...infected, scan_finding: 'Eicar\nSignature' },
      ],
      // Tried a bounded number of times.
      ['file_objects_scan_attempts_check', { scan_attempts: 33 }],
      ['file_objects_scan_attempts_check', { scan_attempts: -1 }],
    ] as const) {
      expect([
        constraint,
        values,
        await outcome(a, fileRow(a, values)),
      ]).toEqual([constraint, values, { code: CHECK_VIOLATION, constraint }]);
    }
    // A row in each state keeps them all.
    for (const values of [
      {},
      { status: 'UPLOADING' },
      { status: 'UPLOADED', quarantine_version_id: 'v-1' },
      { status: 'SCANNING', quarantine_version_id: 'v-1' },
      {
        ...clean,
        status: 'READY',
        finalized_at: at,
        retention_class: 'CONTRACT_EVIDENCE',
      },
      infected,
      {
        status: 'FAILED',
        scan_verdict: 'ERROR',
        scanned_at: at,
        scan_attempts: 8,
      },
      { status: 'ABORTED' },
    ]) {
      expect([values, await outcome(a, fileRow(a, values))]).toEqual([
        values,
        'written',
      ]);
    }
    // A key is its tenant's once: the same quarantine key twice is refused.
    const key = keyOf(tenants[0], 'quarantine');
    const twice = await as(a, [
      insertFile(fileRow(a, { quarantine_key: key })),
      insertFile(fileRow(a, { quarantine_key: key })),
    ]);
    expect(twice).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'file_objects_tenant_id_quarantine_key_key',
    });
  });

  it('a_files_identity_never_changes_once_pinned', async () => {
    const [a] = members;
    const id = randomUUID();
    const pinned = fileRow(a, {
      id,
      status: 'UPLOADED',
      quarantine_version_id: 'v-1',
    });
    const promoted = {
      object_key: keyOf(tenants[0], 'objects'),
      object_version_id: 'v-object',
      sha256: sha256('scanned bytes'),
    };
    const change = (set: string, params: unknown[]) =>
      as(a, [
        insertFile(pinned),
        [
          `UPDATE file_objects SET status = 'READY', scan_verdict = 'CLEAN', scanned_at = now(), finalized_at = now(),
                  object_key = $2, object_version_id = $3, sha256 = $4 WHERE id = $1`,
          [
            id,
            promoted.object_key,
            promoted.object_version_id,
            promoted.sha256,
          ],
        ],
        [
          `UPDATE file_objects SET ${set} WHERE id = $1 RETURNING id`,
          [id, ...params],
        ],
      ]);
    // Moving on is allowed: a later status, the scan's verdict.
    expect(
      await change('retention_class = $2', ['CONTRACT_EVIDENCE']),
    ).toMatchObject({
      rows: [{ id }],
    });
    // Its identity is not: neither its pinned version, nor its object, its
    // version or its hash, nor its size, its key or its creator.
    for (const [set, params] of [
      ['quarantine_version_id = $2', ['v-2']],
      ['object_key = $2', [keyOf(tenants[0], 'objects')]],
      ['object_version_id = $2', ['v-other']],
      ['sha256 = $2', [sha256('other bytes')]],
      ['size_bytes = $2', ['2048']],
      ['quarantine_key = $2', [keyOf(tenants[0], 'quarantine')]],
      ['created_by_id = $2', [members[0].id === a.id ? randomUUID() : a.id]],
    ] as const) {
      const refused = await change(set, [...params]);
      expect([set, refused]).toMatchObject([
        set,
        {
          code: INTEGRITY_VIOLATION,
          message: "file_objects: a file's identity cannot change once pinned",
        },
      ]);
    }
  });

  it('an_upload_names_its_owner_without_joining_it', async () => {
    const [a, b] = members;
    const fileId = randomUUID();
    const session = (
      values: Record<string, unknown> = {},
    ): [string, unknown[]] => {
      const row = {
        id: randomUUID(),
        tenant_id: a.tenantId,
        file_object_id: fileId,
        created_by_id: a.id,
        declared_size: '1024',
        declared_type: 'application/pdf',
        owner_kind: 'player-document',
        // An owner no table holds: a declared intent, checked by its policy,
        // never a foreign key.
        owner_id: randomUUID(),
        expires_at: new Date(Date.now() + 15 * 60_000),
        ...values,
      };
      const columns = Object.keys(row);
      return [
        `INSERT INTO upload_sessions (${columns.join(', ')})
         VALUES (${columns.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      ];
    };
    const file = insertFile(fileRow(a, { id: fileId }));
    expect(await as(a, [file, session()])).toMatchObject({ rows: [{}] });
    const at = new Date();
    for (const [constraint, values] of [
      ['upload_sessions_declared_size_check', { declared_size: '0' }],
      ['upload_sessions_declared_type_check', { declared_type: 'pdf' }],
      ['upload_sessions_owner_kind_check', { owner_kind: 'Player_Document' }],
      [
        'upload_sessions_closed_once_check',
        { finalized_at: at, aborted_at: at },
      ],
      [
        'upload_sessions_expiry_check',
        { expires_at: new Date(Date.now() - 1_000) },
      ],
      ['upload_sessions_revision_check', { revision: 0 }],
    ] as const) {
      expect([constraint, await as(a, [file, session(values)])]).toMatchObject([
        constraint,
        { code: CHECK_VIOLATION, constraint },
      ]);
    }
    // One upload per file.
    expect(await as(a, [file, session(), session()])).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'upload_sessions_tenant_id_file_object_id_key',
    });
    // Its file is its own tenant's, and so is its maker: tenant B's file,
    // committed, cannot be named by tenant A's upload.
    const { id: other } = await asTenant(b.tenantId, (tx) =>
      tx.fileObject.create({
        data: {
          tenantId: b.tenantId,
          quarantineKey: keyOf(tenants[1], 'quarantine'),
          sizeBytes: 1024n,
          mimeType: 'application/pdf',
          originalName: 'contract.pdf',
          classification: 'OPERATIONAL',
          createdById: b.id,
        },
        select: { id: true },
      }),
    );
    expect(await as(a, [session({ file_object_id: other })])).toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'upload_sessions_file_object_id_tenant_id_fkey',
    });
    expect(await as(a, [file, session({ created_by_id: b.id })])).toMatchObject(
      {
        code: FOREIGN_KEY_VIOLATION,
        constraint: 'upload_sessions_created_by_id_tenant_id_fkey',
      },
    );
  });

  it('the_legacy_documents_table_takes_no_new_writes', async () => {
    const [a] = members;
    const player = await createPlayer(tenants[0]);
    // Its rows are kept, and read: one legacy row, as only the owner writes it.
    const legacy = await asContainedTableOwner('documents', (tx) =>
      tx.document.create({
        data: {
          tenantId: a.tenantId,
          entityType: 'PLAYER',
          entityId: player.id,
          fileUrl: 'objects/legacy',
          fileName: 'legacy.pdf',
        },
        select: { id: true },
      }),
    );
    expect(
      await as(a, [['SELECT id FROM documents WHERE id = $1', [legacy.id]]]),
    ).toEqual({ rows: [{ id: legacy.id }] });
    // No new row, no change, no removal, as the runtime role.
    for (const [sql, params] of [
      [
        `INSERT INTO documents (id, tenant_id, entity_type, entity_id, file_url, file_name, updated_at)
         VALUES ($1, $2, 'PLAYER', $3, 'objects/new', 'new.pdf', now())`,
        [randomUUID(), a.tenantId, player.id],
      ],
      [
        'UPDATE documents SET file_name = $2 WHERE id = $1',
        [legacy.id, 'renamed.pdf'],
      ],
      ['DELETE FROM documents WHERE id = $1', [legacy.id]],
    ] as const) {
      expect([
        sql.split(' ')[0],
        await as(a, [[sql, [...params]]]),
      ]).toMatchObject([sql.split(' ')[0], { code: INSUFFICIENT_PRIVILEGE }]);
    }
  });
});
