import type { ConfidentialClass } from '../../common/policy/confidential-class';

/**
 * How an audit payload records a field (0.7.2; SR-AUD-004):
 * - `OPERATIONAL`: its value — a role, a status, a locale, an instant, an id;
 * - `PERSONAL`: a reference to where the value lives, never the value — an
 *   address, a name, a phone number: personal data stays out of audit values
 *   (docs/reference/security-privacy.md);
 * - a confidential class (`IDENTITY`, `MEDICAL`, `LEGAL_INTERNAL`, `FINANCE`,
 *   `MINOR_POLICY`): a reference too, never the value.
 */
export type AuditFieldClass = 'OPERATIONAL' | 'PERSONAL' | ConfidentialClass;

interface AuditedAction {
  /** The entity the action changes: the audit row's entity type. */
  readonly entity: string;
  /** Every field its before and after may carry, and how each is recorded. */
  readonly fields: Readonly<Record<string, AuditFieldClass>>;
  /**
   * A change of a role or a permission (SR-ACL-006): recorded with the state
   * before and the state after, every field in both.
   */
  readonly beforeAndAfter?: true;
}

/**
 * Every audited action, and the allowlist of what its payload may carry
 * (0.7.2; SR-AUD-002–004). A field not listed is refused, so nothing reaches
 * an audit row by being passed along — never a request body. An action enters
 * here with the use case that records it.
 */
export const AUDITED_ACTIONS = {
  'invitation.created': {
    entity: 'Invitation',
    fields: {
      email: 'PERSONAL',
      role: 'OPERATIONAL',
      locale: 'OPERATIONAL',
      expiresAt: 'OPERATIONAL',
    },
  },
  'invitation.revoked': {
    entity: 'Invitation',
    fields: { status: 'OPERATIONAL' },
  },
  'invitation.accepted': {
    entity: 'Invitation',
    fields: {
      status: 'OPERATIONAL',
      memberId: 'OPERATIONAL',
      role: 'OPERATIONAL',
    },
  },
  'membership.reactivated': {
    entity: 'User',
    fields: { archivedAt: 'OPERATIONAL' },
  },
  // No route changes a member's role yet (1.1.x): the command that does will
  // record this, before and after.
  'member.role_changed': {
    entity: 'User',
    fields: { role: 'OPERATIONAL' },
    beforeAndAfter: true,
  },
  // Access events (0.7.4; I-5): a record's access-audited classes, read.
  // Only the classes' names, never the content; the access audit records
  // them (access-audit.ts), each readable entity with an action of its own.
  'medical_record.read': {
    entity: 'MedicalRecord',
    fields: { classes: 'OPERATIONAL' },
  },
  // An upload (0.8.3): started — its file made, its link handed out — and
  // completed, its exact version pinned. The file's name is the uploader's
  // words, so a reference, never the value.
  'file.upload_started': {
    entity: 'FileObject',
    fields: {
      ownerKind: 'OPERATIONAL',
      ownerId: 'OPERATIONAL',
      fileName: 'PERSONAL',
      type: 'OPERATIONAL',
      sizeBytes: 'OPERATIONAL',
      expiresAt: 'OPERATIONAL',
    },
  },
  'file.uploaded': {
    entity: 'FileObject',
    fields: {
      status: 'OPERATIONAL',
      quarantineVersionId: 'OPERATIONAL',
    },
  },
  // The scan's outcome (0.8.4), by the worker: promoted to an immutable
  // version, rejected for what the scanner found, or failed with no verdict.
  'file.promoted': {
    entity: 'FileObject',
    fields: {
      status: 'OPERATIONAL',
      scanVerdict: 'OPERATIONAL',
      objectVersionId: 'OPERATIONAL',
      sha256: 'OPERATIONAL',
    },
  },
  'file.rejected': {
    entity: 'FileObject',
    fields: {
      status: 'OPERATIONAL',
      scanVerdict: 'OPERATIONAL',
      scanFinding: 'OPERATIONAL',
    },
  },
  'file.scan_failed': {
    entity: 'FileObject',
    fields: { status: 'OPERATIONAL', scanVerdict: 'OPERATIONAL' },
  },
  'tenant.provisioned': {
    entity: 'Tenant',
    fields: {
      slug: 'OPERATIONAL',
      domain: 'OPERATIONAL',
      ownerMembershipId: 'OPERATIONAL',
      tenantCreated: 'OPERATIONAL',
      hostsRegistered: 'OPERATIONAL',
      accountCreated: 'OPERATIONAL',
      membershipCreated: 'OPERATIONAL',
    },
  },
} as const satisfies Readonly<Record<string, AuditedAction>>;

export type AuditAction = keyof typeof AUDITED_ACTIONS;

type FieldOf<A extends AuditAction> =
  keyof (typeof AUDITED_ACTIONS)[A]['fields'] & string;

/**
 * A field's value, as the caller has it: a structural delta is flat — a scalar,
 * an instant, or a list of scalars — never a nested object.
 */
export type AuditValue =
  | string
  | number
  | boolean
  | null
  | Date
  | readonly (string | number | boolean)[];

export type AuditValues<A extends AuditAction> = {
  readonly [F in FieldOf<A>]?: AuditValue;
};

/** One audited action on one entity: what it was before and after. */
export interface AuditEvent<A extends AuditAction = AuditAction> {
  readonly action: A;
  readonly entityId: string;
  readonly before?: AuditValues<A>;
  readonly after?: AuditValues<A>;
  /** Why, when the action has a reason: a code the system gives, at most 500 characters. */
  readonly reason?: string;
}
