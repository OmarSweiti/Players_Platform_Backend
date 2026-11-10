/**
 * The confidential classes of docs/reference/security-privacy.md ("Authorization,
 * field classification and role defaults"): data that no member receives by
 * omission or default (SR-ACL-008). A response carries a field of one only
 * when the member's role holds the class's explicit grant and the resource's
 * policy discloses it to them (0.6.4). Every other field a response carries
 * is operational, for the members its route admits.
 */
export const CONFIDENTIAL_CLASSES = [
  'IDENTITY',
  'MEDICAL',
  'LEGAL_INTERNAL',
  'FINANCE',
  'MINOR_POLICY',
] as const;

export type ConfidentialClass = (typeof CONFIDENTIAL_CLASSES)[number];

/**
 * The classes whose release is access-audited (0.7.4; I-5): a response that
 * carries a field of one is released only after an access event records who
 * read which record's which classes (src/infrastructure/audit/access-
 * audit.ts). `MINOR_POLICY` is not among them: the plan names these four.
 */
export const ACCESS_AUDITED_CLASSES: readonly ConfidentialClass[] = [
  'IDENTITY',
  'MEDICAL',
  'LEGAL_INTERNAL',
  'FINANCE',
];
