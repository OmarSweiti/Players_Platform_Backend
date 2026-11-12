import { z } from 'zod';
import { id, instant } from '../../../../common/validation/schemas';
import { FILE_STATUSES } from '../../domain/file-object';
import { FILE_NAME_MAX } from '../../domain/file-name';
import { UPLOAD_KIND_NAMES, UPLOAD_TYPES } from '../../domain/upload-kinds';

const ownerKind = z
  .enum(UPLOAD_KIND_NAMES)
  .describe('What the file is for: `player-document`, a player');
const type = z
  .enum(UPLOAD_TYPES)
  .describe("The file's type; its kind of owner takes some, not all");
const sizeBytes = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .describe('The exact size, in bytes');

/** An upload to start (0.8.3): what it is for, and the file to come. */
export const StartUploadBody = z
  .strictObject({
    ownerKind,
    ownerId: id.describe('The owner: for a `player-document`, the player'),
    fileName: z
      .string()
      .min(1)
      .max(FILE_NAME_MAX * 2)
      .describe(
        'The name it is shown and saved as, ending in its type’s extension: display only, never where it is stored',
      ),
    type,
    sizeBytes,
  })
  .meta({ id: 'StartUpload' });
export type StartUploadBody = z.infer<typeof StartUploadBody>;

/** The request that sends the file: straight to the store, as given. */
const PresignedPut = z
  .strictObject({
    method: z.literal('PUT'),
    url: z
      .url()
      .describe('Short-lived, and a capability: whoever holds it may send'),
    headers: z
      .record(z.string(), z.string())
      .describe('To send unchanged; the body is exactly `sizeBytes` long'),
    expiresAt: instant.describe('After this, a PUT is refused'),
  })
  .meta({ id: 'PresignedPut' });

/** An upload, as its uploader sees it: never where it is stored. */
export const UploadResponse = z
  .strictObject({
    id,
    fileId: id.describe('The file the upload makes'),
    status: z
      .enum(FILE_STATUSES)
      .describe("The file's: `UPLOADING`, then `UPLOADED` once completed"),
    ownerKind,
    ownerId: id,
    fileName: z.string(),
    type,
    sizeBytes,
    createdAt: instant,
    expiresAt: instant.describe('The last moment it may be completed'),
    completedAt: instant.nullable(),
    put: PresignedPut.nullable().describe(
      'While the upload is open: send the file with it, then complete the upload',
    ),
  })
  .meta({ id: 'Upload' });
