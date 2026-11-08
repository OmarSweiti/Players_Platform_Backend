import { ALLOW, definePolicy, deny } from '../../../../common/policy/policy';

/** What the invitation policy reads of an invitation. */
export interface InvitationPolicyView {
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Invitations (0.5.10; 0.6.3). Any member the route admits sees the tenant's
 * invitations. Revoking an open one revokes it and revoking a revoked one
 * changes nothing; an accepted invitation stays accepted.
 */
export const invitationPolicy = definePolicy<'revoke', InvitationPolicyView>({
  read: () => ALLOW,
  revoke: (_, invitation) =>
    invitation.acceptedAt !== null && invitation.revokedAt === null
      ? deny('STATE')
      : ALLOW,
});
