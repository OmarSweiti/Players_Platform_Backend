import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// Audit inside the business transaction (0.7.2): one service, for every
// module's use cases and for sign-in's bootstrap. Global, and imported by the
// PrismaModule, so that it comes with every transaction's client — the API's
// and the provisioning command's alike.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
