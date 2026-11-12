/** The longest name a file keeps, in characters (`original_name VARCHAR(255)`). */
export const FILE_NAME_MAX = 255;

/**
 * Whether a character may not stand in a file's name: a control (C0, DEL,
 * C1), a path separator, or a bidirectional control — the marks and
 * overrides that make a name read other than it is, an executable shown as
 * if it ended `.pdf` (Unicode TR #36, "bidi spoofing"). Arabic letters are
 * name characters like any other.
 */
function isForbidden(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2f || // /
    codePoint === 0x5c || // \
    codePoint === 0x061c || // Arabic letter mark
    codePoint === 0x200e || // left-to-right mark
    codePoint === 0x200f || // right-to-left mark
    (codePoint >= 0x202a && codePoint <= 0x202e) || // embeddings, overrides
    (codePoint >= 0x2066 && codePoint <= 0x2069) // isolates
  );
}

/** Why a file's name is not safe to keep, or null if it is (0.8.3; SR-DOC-003). */
export type FileNameIssue =
  'empty' | 'too-long' | 'forbidden-character' | 'no-extension' | 'extension';

/**
 * The name a file is shown and saved as, display only (the store's key never
 * comes from it): with no surrounding space, of at most 255 characters,
 * holding no control, separator or bidirectional control, not ending in a
 * dot, and ending in one of `extensions` — the declared type's — in any
 * case. `report.pdf.exe` ends in `exe`; an executable named `report.pdf` is
 * refused by its bytes instead.
 */
export function fileNameIssue(
  name: string,
  extensions: readonly string[],
): FileNameIssue | null {
  const characters = [...name];
  if (name.trim().length === 0) return 'empty';
  if (characters.length > FILE_NAME_MAX) return 'too-long';
  if (characters.some((c) => isForbidden(c.codePointAt(0)!))) {
    return 'forbidden-character';
  }
  if (name !== name.trim() || name.endsWith('.')) {
    return 'forbidden-character';
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'no-extension';
  const extension = name.slice(dot + 1).toLowerCase();
  return extensions.includes(extension) ? null : 'extension';
}

/** A name as kept: Unicode NFC, so that one name is stored one way. */
export function fileNameOf(name: string): string {
  return name.normalize('NFC');
}
