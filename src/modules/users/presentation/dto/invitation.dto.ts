import { UserRole } from '@prisma/client';
import { z } from 'zod';
import {
  cursorPaging,
  id,
  instant,
} from '../../../../common/validation/schemas';
import { INVITATION_STATUSES } from '../../domain/invitation';

const locale = z.enum(['ar', 'en']);

/**
 * The roles an invitation can grant: every tenant role. SUPER_ADMIN is a
 * platform role, which no invitation grants (the database refuses it too).
 */
const invitableRole = z.enum(UserRole).exclude(['SUPER_ADMIN']);

/** `POST /api/v1/users/invitations` (0.5.10). */
export const CreateInvitationBody = z.strictObject({
  email: z.email().max(255).describe('The address to invite'),
  role: invitableRole.describe(
    "The role the invitation grants: never one above the inviter's own",
  ),
  locale: locale
    .optional()
    .describe(
      "The language of the invitation's email; the tenant's default if unsaid",
    ),
});
export type CreateInvitationBody = z.infer<typeof CreateInvitationBody>;

export const InvitationsQuery = z.strictObject({
  ...cursorPaging,
  status: z
    .enum(INVITATION_STATUSES)
    .optional()
    .describe('Only the invitations with this status'),
});
export type InvitationsQuery = z.infer<typeof InvitationsQuery>;

/** An invitation, as its inviters see it: never its token. */
export const InvitationResponse = z
  .strictObject({
    id,
    email: z.string().describe('The address invited'),
    role: invitableRole,
    locale: locale.describe("The language of the invitation's email"),
    status: z
      .enum(INVITATION_STATUSES)
      .describe('Pending until it expires; accepted and revoked are final'),
    invitedById: id.describe('The member who invited'),
    createdAt: instant,
    expiresAt: instant,
    acceptedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .meta({ id: 'Invitation' });
