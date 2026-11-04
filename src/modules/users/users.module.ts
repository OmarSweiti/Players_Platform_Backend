import { Module } from '@nestjs/common';
import { PermissionService } from './application/services/permission.service';
import { ReactivateMembership } from './application/use-cases/reactivate-membership.usecase';

@Module({
  providers: [PermissionService, ReactivateMembership],
  exports: [PermissionService, ReactivateMembership],
})
export class UsersModule {}
