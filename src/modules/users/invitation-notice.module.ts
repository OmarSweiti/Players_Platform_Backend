import { Module } from '@nestjs/common';
import { CLOCK, systemClock } from '../../common/time/clock';
import { InvitationNoticeConsumer } from './application/invitation-notice.consumer';
import { InvitationRecords } from './application/ports/invitation-records.port';
import { IssueInvitationToken } from './application/use-cases/issue-invitation-token.usecase';
import { InvitationRepository } from './infrastructure/repositories/invitation.repository';

// The invitation's notice, for the worker (0.7.8): the consumer, the token it
// makes at send time, and the invitations it reads. No route, no identity
// provider: the worker holds neither. The mail it sends through comes from the
// worker's global MailModule.
@Module({
  providers: [
    { provide: InvitationRecords, useClass: InvitationRepository },
    { provide: CLOCK, useValue: systemClock },
    IssueInvitationToken,
    InvitationNoticeConsumer,
  ],
  exports: [InvitationNoticeConsumer],
})
export class InvitationNoticeModule {}
