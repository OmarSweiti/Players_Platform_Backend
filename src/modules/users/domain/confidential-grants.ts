import type { ConfidentialClass } from '../../../common/policy/confidential-class';
import type { PermissionKey } from './permission-catalog';

/**
 * The explicit grant each confidential class needs (0.6.4): the catalog's
 * confidential permission that the role matrix of
 * docs/reference/security-privacy.md calls "explicit" for it. A member whose
 * role does not hold it receives none of that class, whatever a policy says;
 * a class with no grant reaches no member at all. Only medical's exists: the
 * grants for identity documents, internal legal notes and compensation
 * arrive with the steps that build those records, and a minor's data stays
 * with no grant while the guardian rules are OPEN.
 */
export const CONFIDENTIAL_GRANTS = {
  IDENTITY: null,
  MEDICAL: 'medical.view_confidential',
  LEGAL_INTERNAL: null,
  FINANCE: null,
  MINOR_POLICY: null,
} as const satisfies Readonly<Record<ConfidentialClass, PermissionKey | null>>;
