// A confidential file's download (0.8.5; 0.7.4, I-5): released only to a
// member whose role holds the class's grant and to whom the owner's policy
// discloses it, and only after an access event — who read which file's which
// class — commits; if that event cannot be written, no link is signed. No
// owner's policy discloses a confidential class of a player's document yet
// (1.3.1), so these tests call the use case as the route would, with a policy
// that does — as 0.7.4's tests read a record through a policy of their own.
// Two tenants, as the runtime role, against the test bucket.
import { randomBytes } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Tenant, User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { ALLOW, definePolicy } from '../../src/common/policy/policy';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { AccessAudit } from '../../src/infrastructure/audit/access-audit';
import { AuditService } from '../../src/infrastructure/audit/audit.service';
import { S3Storage } from '../../src/infrastructure/storage/s3-storage';
import {
  FILE_OWNER_POLICIES,
  type FileOwnerPolicy,
} from '../../src/modules/files/application/file-owner.policy';
import type { UploadOwnerView } from '../../src/modules/files/application/ports/upload-owners.port';
import { DownloadFileUseCase } from '../../src/modules/files/application/use-cases/download-file.usecase';
import { FileDownloadRepository } from '../../src/modules/files/infrastructure/repositories/file-download.repository';
import { UploadOwnerRepository } from '../../src/modules/files/infrastructure/repositories/upload-owner.repository';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { PermissionRepository } from '../../src/modules/users/infrastructure/repositories/permission.repository';
import { seedFile } from '../harness/files';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';
import { s3SettingsOf, testStoreClient } from '../harness/object-store';

/** A player document's policy that discloses its medical class: what 1.3.1's may. */
const DISCLOSING: Record<'player-document', FileOwnerPolicy> = {
  'player-document': definePolicy<never, UploadOwnerView>(
    { read: () => ALLOW },
    { MEDICAL: () => ALLOW },
  ),
};

const pdf = () =>
  Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), randomBytes(1015)]);

describe('confidential downloads', () => {
  let admin: S3Client;
  let bucket: string;
  let storage: S3Storage;
  let tenants: [Tenant, Tenant];
  /** In each tenant: the uploader, a clinician holding the medical grant, a coach without it. */
  const people: { scout: User; clinician: User; coach: User }[] = [];
  const players: string[] = [];

  beforeAll(async () => {
    const store = inject('objectStore');
    if (store === null) {
      throw new TypeError(
        'the download tests need the object store: run `just up`, or set S3_*_TEST',
      );
    }
    admin = testStoreClient(store);
    bucket = store.bucket;
    storage = new S3Storage(s3SettingsOf(store));
    tenants = [await createTenant(), await createTenant()];
    for (const tenant of tenants) {
      people.push({
        scout: await createMember(tenant, 'SCOUT'),
        clinician: await createMember(tenant, 'MEDICAL'),
        coach: await createMember(tenant, 'COACH'),
      });
      players.push((await createPlayer(tenant)).id);
    }
  });

  afterAll(() => {
    admin?.destroy();
    storage?.onModuleDestroy();
  });

  /** The use case as the files module composes it, but for its policies and audit. */
  function downloads(
    policies: Record<'player-document', FileOwnerPolicy>,
    audit: AuditService = new AuditService(),
  ) {
    const transactions = new TenantTransactions(runPrisma());
    return new DownloadFileUseCase(
      transactions,
      new FileDownloadRepository(),
      new UploadOwnerRepository(),
      new PermissionService(transactions, new PermissionRepository()),
      storage,
      new AccessAudit(audit),
      policies,
    );
  }

  function seeded(i: number, classification: 'MEDICAL' | 'OPERATIONAL') {
    return seedFile({ client: admin, bucket }, tenants[i], people[i].scout, {
      bytes: pdf(),
      owner: { kind: 'player-document', id: players[i] },
      classification,
    });
  }

  function accessEventsOf(tenant: Tenant, fileId: string) {
    return asTenant(tenant.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: fileId, action: 'file.read' },
        select: {
          action: true,
          entityType: true,
          actorType: true,
          userId: true,
          actorRole: true,
          newValues: true,
        },
      }),
    );
  }

  it('a_confidential_download_leaves_an_access_event_before_its_link', async () => {
    for (const [i, tenant] of tenants.entries()) {
      const { clinician, coach } = people[i];
      const file = await seeded(i, 'MEDICAL');

      // The clinician holds the grant, and the policy discloses the class:
      // the file is released, after one event naming its class.
      const released = await downloads(DISCLOSING).execute(
        memberContext(clinician),
        file.fileId,
      );
      expect(released.sha256.equals(file.sha256)).toBe(true);
      const fetched = await fetch(released.get.url);
      expect(Buffer.from(await fetched.arrayBuffer()).equals(file.bytes)).toBe(
        true,
      );
      expect(await accessEventsOf(tenant, file.fileId)).toEqual([
        {
          action: 'file.read',
          entityType: 'FileObject',
          actorType: 'USER',
          userId: clinician.id,
          actorRole: 'MEDICAL',
          newValues: { classes: ['MEDICAL'] },
        },
      ]);

      // A coach's role holds no medical grant: as absent, and no event.
      await expect(
        downloads(DISCLOSING).execute(memberContext(coach), file.fileId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Nor does the other tenant's clinician find it.
      await expect(
        downloads(DISCLOSING).execute(
          memberContext(people[1 - i].clinician),
          file.fileId,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await accessEventsOf(tenant, file.fileId)).toHaveLength(1);

      // An operational file needs no event.
      const plain = await seeded(i, 'OPERATIONAL');
      await downloads(DISCLOSING).execute(
        memberContext(clinician),
        plain.fileId,
      );
      expect(await accessEventsOf(tenant, plain.fileId)).toEqual([]);
    }
  });

  it('a_failed_access_event_withholds_the_link', async () => {
    const failing = new AuditService();
    vi.spyOn(failing, 'record').mockRejectedValue(
      new TypeError('injected fault: the audit insert fails'),
    );
    const signs = vi.spyOn(storage, 'presignGet');
    signs.mockClear();
    for (const [i, tenant] of tenants.entries()) {
      const file = await seeded(i, 'MEDICAL');
      let released: unknown;
      await expect(
        downloads(DISCLOSING, failing)
          .execute(memberContext(people[i].clinician), file.fileId)
          .then((value) => (released = value)),
      ).rejects.toThrow(/injected fault/);
      expect(released).toBeUndefined();
      expect(await accessEventsOf(tenant, file.fileId)).toEqual([]);
    }
    // No link was ever signed.
    expect(signs).not.toHaveBeenCalled();
    signs.mockRestore();
  });

  it('a_grant_alone_never_releases_a_confidential_file', async () => {
    // The app's own policies: a player document discloses no class yet.
    for (const [i, tenant] of tenants.entries()) {
      const file = await seeded(i, 'MEDICAL');
      await expect(
        downloads(FILE_OWNER_POLICIES).execute(
          memberContext(people[i].clinician),
          file.fileId,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await accessEventsOf(tenant, file.fileId)).toEqual([]);
    }
  });
});
