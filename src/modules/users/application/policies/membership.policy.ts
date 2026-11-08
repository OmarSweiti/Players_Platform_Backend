import { ALLOW, definePolicy, deny } from '../../../../common/policy/policy';

/** What the membership policy reads of a member. */
export interface MembershipView {
  /** When the membership was archived, if it is. */
  readonly deletedAt: Date | null;
}

/**
 * A tenant's memberships (0.4.9; 0.6.3): only an archived membership is
 * brought back. Who may bring one back — the grant policy a role change
 * follows — arrives with member administration (`1.1.1`).
 */
export const membershipPolicy = definePolicy<'reactivate', MembershipView>({
  read: () => ALLOW,
  reactivate: (_, member) =>
    member.deletedAt !== null ? ALLOW : deny('STATE'),
});
