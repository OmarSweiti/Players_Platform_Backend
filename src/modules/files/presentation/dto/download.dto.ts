import { z } from 'zod';
import { id, instant } from '../../../../common/validation/schemas';

/** The request that fetches the file: straight from the store, as given. */
const PresignedGet = z
  .strictObject({
    method: z.literal('GET'),
    url: z
      .url()
      .describe(
        'A minute long, and a capability: whoever holds it may fetch the file until then',
      ),
    expiresAt: instant.describe('After this, the link is refused'),
  })
  .meta({ id: 'PresignedGet' });

/** A file released to its reader (0.8.5): what it is, and the link to its scanned bytes. */
export const DownloadResponse = z
  .strictObject({
    fileId: id,
    fileName: z
      .string()
      .describe('The name it is saved as: the uploader’s, display only'),
    type: z
      .string()
      .describe('Its type, as declared and checked: `type/subtype`'),
    sizeBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('The SHA-256 of the bytes the link serves, in hexadecimal'),
    get: PresignedGet.describe(
      'The exact version that was scanned clean, saved as an attachment',
    ),
  })
  .meta({ id: 'FileDownload' });
