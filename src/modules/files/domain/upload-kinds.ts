import type { FileClassification } from './file-object';

/** A file type an upload may declare: `type/subtype`, lower case. */
export type UploadType = 'application/pdf' | 'image/jpeg' | 'image/png';

/**
 * What an upload may be for (0.8.3; DB-69): a kind of owner, and what it
 * accepts. The kind names the owner its id refers to — `player-document`, a
 * player — whose policy authorizes the upload; the types it takes, each with
 * the extensions a file's name may end in; the largest file; and the
 * classification a file starts with, which its binding may only raise
 * (`1.3.1`: rebinding never declassifies). A kind enters here with its
 * owner's typed binding: player media `1.3.3`, contract versions `1.4.8`,
 * legal attachments `1.5.3`, message attachments `2.6.5`.
 */
export interface UploadKind {
  /** What the owner id names. */
  readonly owner: 'player';
  /** Each type it accepts, and the extensions a file of that type ends in. */
  readonly types: Readonly<Partial<Record<UploadType, readonly string[]>>>;
  /** The largest file, in bytes. */
  readonly maxBytes: number;
  readonly classification: FileClassification;
}

const MiB = 1024 * 1024;

export const UPLOAD_KINDS = {
  // A player's document — a contract scan, an identity page, a certificate —
  // as a PDF or a photographed page (1.3.1 binds it).
  'player-document': {
    owner: 'player',
    types: {
      'application/pdf': ['pdf'],
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
    },
    maxBytes: 25 * MiB,
    classification: 'OPERATIONAL',
  },
} as const satisfies Readonly<Record<string, UploadKind>>;

export type UploadKindName = keyof typeof UPLOAD_KINDS;

export const UPLOAD_KIND_NAMES = Object.keys(UPLOAD_KINDS) as [
  UploadKindName,
  ...UploadKindName[],
];

/** Every type some kind accepts. */
export const UPLOAD_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const satisfies readonly UploadType[];

/** The extensions `kind` accepts for `type`; none if it does not take the type. */
export function extensionsFor(
  kind: UploadKindName,
  type: UploadType,
): readonly string[] {
  const types: UploadKind['types'] = UPLOAD_KINDS[kind].types;
  return types[type] ?? [];
}
