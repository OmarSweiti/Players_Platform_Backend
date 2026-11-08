// The field classification (0.6.4; I-2, SR-ACL-008, BR-OBJ-05): every field a
// response carries, route by route, with its class, written from the classes
// of docs/reference/security-privacy.md and reviewed apart from the code it
// checks. It imports nothing from src/ — no response schema, no
// confidentiality marker, no grant — so a marker the code loses, a field it
// adds or a select it widens is caught by test/authz/confidential-fields
// .e2e-spec.ts rather than copied here. A response field the code adds comes
// here in the same PR (.claude/rules/backend.md).
//
// Field-level classification and recipient rules are OPEN for the agency
// (security-privacy.md): until it approves them, this is the engineering
// default, the safer class where unsure.

/**
 * security-privacy.md's classes, and PUBLIC — what anyone may be told, signed
 * in or not. OPERATIONAL is for the members a route admits; the five after it
 * are confidential.
 */
export type DataClass =
  | 'PUBLIC'
  | 'OPERATIONAL'
  | 'IDENTITY'
  | 'MEDICAL'
  | 'LEGAL_INTERNAL'
  | 'FINANCE'
  | 'MINOR_POLICY';

export type ConfidentialClass = Exclude<DataClass, 'PUBLIC' | 'OPERATIONAL'>;

export const CONFIDENTIAL: readonly ConfidentialClass[] = [
  'IDENTITY',
  'MEDICAL',
  'LEGAL_INTERNAL',
  'FINANCE',
  'MINOR_POLICY',
];

/**
 * Who may receive a confidential class: a role the role matrix calls eligible
 * for it ("explicit"), which holds the class's permission. A class with no
 * permission yet reaches nobody.
 */
export const AUDIENCE: Readonly<
  Record<
    ConfidentialClass,
    { readonly permission: string; readonly eligible: readonly string[] } | null
  >
> = {
  // "assigned identity administrators or legal users with explicit identity
  // permission": no such permission exists yet.
  IDENTITY: null,
  // "assigned medical/physiotherapy staff with purpose and confidential
  // permission"; the matrix: "full data explicit".
  MEDICAL: {
    permission: 'medical.view_confidential',
    eligible: ['MEDICAL', 'PHYSIOTHERAPIST'],
  },
  // "authorized legal case staff with explicit confidential permission".
  LEGAL_INTERNAL: null,
  // "authorized finance staff or specific approvers with an explicit
  // compensation grant".
  FINANCE: null,
  // "the underlying class policy plus verified scoped guardian rules where
  // approved": the guardian rules are OPEN.
  MINOR_POLICY: null,
};

/** Fields by path inside `data`: `member.id`; `[]` steps into a list. */
export type Fields = Readonly<Record<string, DataClass>>;

/**
 * A problem (RFC 9457; docs/reference/api.md): what any caller may be told,
 * signed in or not. It names a code and a field, never a resource's data.
 */
export const PROBLEM: Fields = {
  type: 'PUBLIC',
  title: 'PUBLIC',
  status: 'PUBLIC',
  detail: 'PUBLIC',
  instance: 'PUBLIC',
  code: 'PUBLIC',
  message: 'PUBLIC',
  requestId: 'PUBLIC',
  'fieldErrors[].field': 'PUBLIC',
  'fieldErrors[].code': 'PUBLIC',
  'fieldErrors[].message': 'PUBLIC',
  stepUpUrl: 'PUBLIC',
};

/** A list's page (0.3.5), beside its items. */
export const PAGE: Fields = {
  nextCursor: 'OPERATIONAL',
  hasMore: 'OPERATIONAL',
};

const SIGNED_OUT: Fields = {
  revoked: 'OPERATIONAL',
  endSessionUrl: 'OPERATIONAL',
};

/** An invitation, as those who invite read it. */
const invitation = (at: '' | '[].'): Fields => ({
  [`${at}id`]: 'OPERATIONAL',
  // The invitee's address: contact data for those who invite, not an
  // identity document (security-privacy.md's IDENTITY).
  [`${at}email`]: 'OPERATIONAL',
  [`${at}role`]: 'OPERATIONAL',
  [`${at}locale`]: 'OPERATIONAL',
  [`${at}status`]: 'OPERATIONAL',
  [`${at}invitedById`]: 'OPERATIONAL',
  [`${at}createdAt`]: 'OPERATIONAL',
  [`${at}expiresAt`]: 'OPERATIONAL',
  [`${at}acceptedAt`]: 'OPERATIONAL',
  [`${at}revokedAt`]: 'OPERATIONAL',
});

/**
 * Each route's `data`, by `METHOD /path` as the app serves it. A route that
 * answers nothing — a redirect, `{ data: null }` — or only problems has no
 * entry: any field it starts to carry is unclassified.
 */
export const RESPONSES: Readonly<Record<string, Fields>> = {
  'GET /health/live': { status: 'PUBLIC' },
  'GET /health/ready': { status: 'PUBLIC' },

  // A member's own session (@SignedIn: only that session reads it).
  'GET /api/v1/auth/session': {
    'member.id': 'OPERATIONAL',
    'member.role': 'OPERATIONAL',
    'member.firstName': 'OPERATIONAL',
    'member.lastName': 'OPERATIONAL',
    'tenant.id': 'OPERATIONAL',
    'tenant.slug': 'OPERATIONAL',
    'tenant.name': 'OPERATIONAL',
    'tenant.locale': 'OPERATIONAL',
    // The member's own role's permissions (0.6.6), for shaping their
    // navigation: the role matrix is the product's, not a confidential fact.
    'permissions[]': 'OPERATIONAL',
    // The session's own anti-forgery token, for its own page's writes.
    csrfToken: 'OPERATIONAL',
  },
  'POST /api/v1/auth/logout': SIGNED_OUT,
  'POST /api/v1/auth/logout-all': SIGNED_OUT,
  'GET /api/v1/auth/sessions': {
    '[].id': 'OPERATIONAL',
    '[].createdAt': 'OPERATIONAL',
    '[].lastSeenAt': 'OPERATIONAL',
    '[].idleExpiresAt': 'OPERATIONAL',
    '[].absoluteExpiresAt': 'OPERATIONAL',
    '[].acr': 'OPERATIONAL',
    '[].current': 'OPERATIONAL',
  },

  'POST /api/v1/users/invitations': invitation(''),
  'GET /api/v1/users/invitations': invitation('[].'),
};
