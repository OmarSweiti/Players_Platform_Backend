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
