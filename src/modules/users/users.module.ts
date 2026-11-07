import { Module } from '@nestjs/common';
import { CLOCK, systemClock } from '../../common/time/clock';
import { IdentityModule } from '../identity/identity.module';
import { InvitationRecords } from './application/ports/invitation-records.port';
import { PermissionRecords } from './application/ports/permission-records.port';
import { PermissionService } from './application/services/permission.service';
import { InviteMemberUseCase } from './application/use-cases/invite-member.usecase';
import { IssueInvitationToken } from './application/use-cases/issue-invitation-token.usecase';
import { ManageInvitationsUseCase } from './application/use-cases/manage-invitations.usecase';
import { ReactivateMembership } from './application/use-cases/reactivate-membership.usecase';
import { InvitationRepository } from './infrastructure/repositories/invitation.repository';
import { PermissionRepository } from './infrastructure/repositories/permission.repository';
import { InvitationsController } from './presentation/invitations.controller';

// Users: memberships (0.4.9), the permissions their roles hold (0.6.1), and
// invitations (0.5.10), which ask the identity provider for the invitee's
// account. IssueInvitationToken is for the invitation email's delivery (0.7.8).
@Module({
  imports: [IdentityModule],
  controllers: [InvitationsController],
  providers: [
    { provide: InvitationRecords, useClass: InvitationRepository },
    { provide: PermissionRecords, useClass: PermissionRepository },
    { provide: CLOCK, useValue: systemClock },
    PermissionService,
    ReactivateMembership,
    InviteMemberUseCase,
    ManageInvitationsUseCase,
    IssueInvitationToken,
  ],
  exports: [PermissionService, ReactivateMembership, IssueInvitationToken],
})
export class UsersModule {}
