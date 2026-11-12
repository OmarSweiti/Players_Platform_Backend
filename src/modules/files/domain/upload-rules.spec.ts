import { describe, expect, it } from 'vitest';
import { hasSignatureOf, SIGNATURE_BYTES } from './content-signature';
import { FILE_NAME_MAX, fileNameIssue, fileNameOf } from './file-name';
import {
  extensionsFor,
  UPLOAD_KIND_NAMES,
  UPLOAD_KINDS,
  UPLOAD_TYPES,
  type UploadType,
} from './upload-kinds';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(Buffer.from(text, 'latin1'));

const PDF = ascii('%PDF-1.7\n%âãÏÓ\n');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
// A Windows executable's first bytes: "MZ", then its DOS header.
const EXECUTABLE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00);

describe('what an upload may be', () => {
  it('each kind takes only types whose signatures are known, under a bound', () => {
    for (const kind of UPLOAD_KIND_NAMES) {
      const { types, maxBytes } = UPLOAD_KINDS[kind];
      for (const type of Object.keys(types)) {
        expect(UPLOAD_TYPES).toContain(type);
        expect(extensionsFor(kind, type as UploadType).length).toBeGreaterThan(
          0,
        );
      }
      expect(Number.isSafeInteger(maxBytes) && maxBytes > 0).toBe(true);
    }
    expect(extensionsFor('player-document', 'application/pdf')).toEqual([
      'pdf',
    ]);
  });

  it('a file is of its declared type only if it begins as one does', () => {
    const cases: Array<[UploadType, Uint8Array, boolean]> = [
      ['application/pdf', PDF, true],
      ['image/jpeg', JPEG, true],
      ['image/png', PNG, true],
      // An executable, whatever its name says.
      ['application/pdf', EXECUTABLE, false],
      ['image/jpeg', EXECUTABLE, false],
      ['image/png', EXECUTABLE, false],
      // Another type's bytes.
      ['application/pdf', PNG, false],
      ['image/png', JPEG, false],
      ['image/jpeg', PDF, false],
      // Too few bytes to begin as anything.
      ['application/pdf', ascii('%PDF'), false],
      ['image/png', PNG.slice(0, 7), false],
      ['image/jpeg', bytes(), false],
    ];
    for (const [type, head, expected] of cases) {
      expect([type, hasSignatureOf(type, head)]).toEqual([type, expected]);
    }
    // Every signature fits in the bytes read for it.
    expect(PNG.slice(0, 8).length).toBeLessThanOrEqual(SIGNATURE_BYTES);
  });

  it('a file name is kept only if it is safe to show and save', () => {
    const pdf = ['pdf'];
    const images = ['jpg', 'jpeg'];
    // Names a person gives, in Arabic and English.
    expect(fileNameIssue('عقد اللاعب 2026.pdf', pdf)).toBeNull();
    expect(fileNameIssue('Medical certificate (signed).PDF', pdf)).toBeNull();
    expect(fileNameIssue('scan.JPEG', images)).toBeNull();
    expect(
      fileNameIssue('a'.repeat(FILE_NAME_MAX - 4) + '.pdf', pdf),
    ).toBeNull();

    const refused: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['a'.repeat(FILE_NAME_MAX - 3) + '.pdf', 'too-long'],
      ['../../etc/passwd.pdf', 'forbidden-character'],
      ['folder\\report.pdf', 'forbidden-character'],
      ['report\u0000.pdf', 'forbidden-character'],
      ['report\u0007.pdf', 'forbidden-character'],
      ['report\u0085.pdf', 'forbidden-character'],
      // An executable dressed as a PDF by a right-to-left override.
      ['invoice‮fdp.exe', 'forbidden-character'],
      ['invoice⁧fdp.exe⁩', 'forbidden-character'],
      ['report‏.pdf', 'forbidden-character'],
      [' report.pdf', 'forbidden-character'],
      ['report.pdf ', 'forbidden-character'],
      ['report.', 'forbidden-character'],
      ['report', 'no-extension'],
      ['.pdf', 'no-extension'],
      ['report.pdf.exe', 'extension'],
      ['report.png', 'extension'],
    ];
    for (const [name, issue] of refused) {
      expect([name, fileNameIssue(name, pdf)]).toEqual([name, issue]);
    }
  });

  it('a name is kept in one form', () => {
    // "é" composed and decomposed: one name.
    expect(fileNameOf('résumé.pdf')).toBe('résumé.pdf');
  });
});
