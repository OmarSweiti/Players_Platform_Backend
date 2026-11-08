import type { UserRole } from '@prisma/client';

/**
 * The roles the legacy medical use cases let change a confidential record or
 * anyone's treatment session (0.6.3). `SUPER_ADMIN` was a third and is not:
 * the platform holds no tenant's data (I-2; 0.6.7). Bringing medical
 * access into line with the role matrix — purpose, assignment and the
 * explicit `medical.view_confidential` — is `0.6.8`'s.
 */
export const MEDICAL_STAFF: ReadonlySet<UserRole> = new Set<UserRole>([
  'MEDICAL',
  'PHYSIOTHERAPIST',
]);
