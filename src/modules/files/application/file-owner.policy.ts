import type { Policy } from '../../../common/policy/policy';
import type { UploadKindName } from '../domain/upload-kinds';
import type { UploadOwnerView } from './ports/upload-owners.port';
import { uploadOwnerPolicy } from './upload.policy';

/**
 * Whose files a member may download (0.8.5; SR-DOC-002): a file is read
 * through its owner — a member who may read the owner may read its files —
 * and a confidential file only when the owner's policy also discloses the
 * file's class to them, their role holding the class's grant
 * (`disclosedClasses`).
 */
export type FileOwnerPolicy = Policy<'read', UploadOwnerView>;

/**
 * Each kind of owner's policy. A player's is the upload's owner policy until
 * the player's own arrives (`1.2.1`): it discloses no confidential class, so
 * no member downloads a confidential player document until a policy says who
 * may (`1.3.1`) — missing policy denies (I-2).
 */
export const FILE_OWNER_POLICIES: Readonly<
  Record<UploadKindName, FileOwnerPolicy>
> = {
  'player-document': uploadOwnerPolicy,
};

/** The owners' policies, as the download reads them: `FILE_OWNER_POLICIES`, in the app. */
export const FILE_OWNER_POLICY_SET = Symbol('FILE_OWNER_POLICY_SET');
