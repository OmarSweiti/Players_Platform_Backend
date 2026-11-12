import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { UploadOwnerRef } from './upload-records.port';

/** An owner an upload may be for, as the upload sees it: what it is, and its id. */
export type UploadOwnerView = UploadOwnerRef;

/**
 * The owners uploads are for (0.8.3; DB-69): looked up in the context's
 * tenant, by kind — a `player-document`'s owner is a player. Another
 * tenant's owner, or none, is null. Never joined: the owner's typed binding
 * (`1.3.1` …) is its only reference.
 */
export abstract class UploadOwners {
  abstract find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    owner: UploadOwnerRef,
  ): Promise<UploadOwnerView | null>;
}
