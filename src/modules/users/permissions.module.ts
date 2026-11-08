import { Module } from '@nestjs/common';
import { PermissionRecords } from './application/ports/permission-records.port';
import { PermissionService } from './application/services/permission.service';
import { PermissionRepository } from './infrastructure/repositories/permission.repository';

// The permissions a member's role holds (0.6.1): the stored default matrix
// and the service that reads it. A module of its own because it depends on
// nothing but the tenant transaction: the permission guard reads it, users
// re-exports it, and identity imports it for the session's effective
// permissions (0.6.6) — which users, importing identity, could not give.
@Module({
  providers: [
    { provide: PermissionRecords, useClass: PermissionRepository },
    PermissionService,
  ],
  exports: [PermissionService],
})
export class PermissionsModule {}
