import type { UploadType } from './upload-kinds';

/**
 * How many of a file's first bytes are read to know its type: enough for
 * every signature below, and bounded (0.8.3; SR-DOC-003).
 */
export const SIGNATURE_BYTES = 16;

const startsWith = (head: Uint8Array, bytes: readonly number[]): boolean =>
  head.length >= bytes.length && bytes.every((byte, at) => head[at] === byte);

/**
 * Each declared type's magic bytes: what a file of that type begins with,
 * whatever its name says. A file that does not begin so is not of its
 * declared type — an executable renamed `.pdf` begins `MZ`, not `%PDF-`.
 */
const SIGNATURES: Readonly<Record<UploadType, (head: Uint8Array) => boolean>> =
  {
    // %PDF-
    'application/pdf': (head) =>
      startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]),
    // A JPEG's start-of-image marker, then another marker.
    'image/jpeg': (head) => startsWith(head, [0xff, 0xd8, 0xff]),
    // The PNG signature, all eight bytes.
    'image/png': (head) =>
      startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };

/** Whether `head`, a file's first bytes, begins as a file of `type` does. */
export function hasSignatureOf(type: UploadType, head: Uint8Array): boolean {
  return SIGNATURES[type](head);
}
