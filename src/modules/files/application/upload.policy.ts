import { ALLOW, definePolicy, deny } from '../../../common/policy/policy';
import type { UploadOwnerView } from './ports/upload-owners.port';
import type { UploadView } from './ports/upload-records.port';

/**
 * What a member may upload for (0.8.3): an owner they may see, in their own
 * tenant. A player is every member's to see who reaches this — the route
 * asks `document.upload` — until the player's own policy arrives (`1.2.1`);
 * an owner's binding checks it again (`1.3.1`).
 */
export const uploadOwnerPolicy = definePolicy<'upload', UploadOwnerView>({
  read: () => ALLOW,
  upload: () => ALLOW,
});

/**
 * An upload is its uploader's: only they see it, and complete it. Another
 * member's is not found, as one in another tenant is.
 */
export const uploadPolicy = definePolicy<'complete', UploadView>({
  read: (member, upload) =>
    upload.createdById === member.userId ? ALLOW : deny('UNRELATED'),
  complete: (member, upload) =>
    upload.createdById === member.userId ? ALLOW : deny('UNRELATED'),
});
