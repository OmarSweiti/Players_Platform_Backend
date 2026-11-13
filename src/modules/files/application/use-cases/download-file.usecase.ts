import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../common/errors/domain-error';
import {
  authorizeRead,
  disclosedClasses,
} from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { AccessAudit } from '../../../../infrastructure/audit/access-audit';
import {
  type ObjectVersion,
  type PresignedRequest,
  StoragePort,
} from '../../../../infrastructure/storage/storage.port';
import { PermissionService } from '../../../users/application/services/permission.service';
import { isServable } from '../../domain/file-object';
import { FileUnavailableError } from '../download-errors';
import {
  FILE_OWNER_POLICY_SET,
  type FileOwnerPolicy,
} from '../file-owner.policy';
import { FileDownloads } from '../ports/file-downloads.port';
import { UploadOwners } from '../ports/upload-owners.port';
import type { UploadKindName } from '../../domain/upload-kinds';

/** How long a download's link lasts, in seconds: the plan's minute (SR-DOC-002). */
export const DOWNLOAD_LINK_SECONDS = 60;

/** A file released to its reader: what it is, its hash, and the link that serves its scanned bytes. */
export interface FileDownload {
  readonly fileId: string;
  readonly fileName: string;
  readonly type: string;
  readonly sizeBytes: number;
  readonly sha256: Buffer;
  readonly get: PresignedRequest;
}

/**
 * Downloading a file (0.8.5; SR-DOC-002, ADR-0009). The file is read in its
 * tenant, then through its owner: a member who may not read the owner — or a
 * file no known owner names — finds nothing, the same answer as another
 * tenant's file. A confidential file is the owner's policy's to disclose,
 * its class's grant held by the member's role; otherwise it is not found
 * either. A file the member may read but that is not `READY` and `CLEAN` —
 * its scan pending, refused or never reached — or that was purged is
 * `FILE_UNAVAILABLE`.
 *
 * The answer is a presigned GET for the **exact key and version the scan
 * promoted** (0.8.4), never the newest at a key nor the quarantine, lasting a
 * minute, saved as an attachment under the file's name. A file of an
 * access-audited class is released only after its access event commits
 * (0.7.4); the link is signed after, outside the transaction.
 */
@Injectable()
export class DownloadFileUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly files: FileDownloads,
    private readonly owners: UploadOwners,
    private readonly permissions: PermissionService,
    private readonly storage: StoragePort,
    private readonly accessAudit: AccessAudit,
    @Inject(FILE_OWNER_POLICY_SET)
    private readonly policies: Readonly<
      Record<UploadKindName, FileOwnerPolicy>
    >,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileDownload> {
    // The member's grants, read first: the policy may disclose only a class
    // whose grant their role holds.
    const granted = await this.permissions.grantedClasses(ctx);
    const released = await this.transactions.withTenantTransaction(
      ctx,
      async (tx) => {
        const file = await this.files.find(tx, ctx, id);
        if (file === null || file.owner === null) {
          throw new NotFoundError('no such file in this tenant');
        }
        const policy = this.policies[file.owner.kind];
        const owner = authorizeRead(
          ctx,
          policy,
          await this.owners.find(tx, ctx, file.owner),
          'no such file in this tenant',
        );
        if (
          file.classification !== 'OPERATIONAL' &&
          !disclosedClasses(ctx, policy, owner, granted).has(
            file.classification,
          )
        ) {
          throw new NotFoundError('no such file in this tenant');
        }
        if (
          !isServable(file) ||
          file.purgedAt !== null ||
          file.promoted === null
        ) {
          throw new FileUnavailableError(
            `file ${file.id}: ${file.status}, ${file.scanVerdict}${file.purgedAt === null ? '' : ', purged'}`,
          );
        }
        const release: Omit<FileDownload, 'get'> & {
          readonly version: ObjectVersion;
        } = {
          fileId: file.id,
          fileName: file.fileName,
          type: file.type,
          sizeBytes: file.sizeBytes,
          sha256: file.promoted.sha256,
          version: file.promoted.version,
        };
        return this.accessAudit.releaseWhole(
          tx,
          ctx,
          { action: 'file.read', id: file.id },
          file.classification,
          release,
        );
      },
    );
    const { version, ...download } = released;
    return {
      ...download,
      get: await this.storage.presignGet(version, {
        expiresInSeconds: DOWNLOAD_LINK_SECONDS,
        downloadName: download.fileName,
      }),
    };
  }
}
