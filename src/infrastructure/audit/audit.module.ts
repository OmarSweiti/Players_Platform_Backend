import { Global, Module } from '@nestjs/common';
import { AccessAudit } from './access-audit';
import { AuditService } from './audit.service';
import { SecurityEvents } from './security-events';

// Audit inside the business transaction (0.7.2): one service, for every
// module's use cases and for sign-in's bootstrap. Global, and imported by the
// PrismaModule, so that it comes with every transaction's client — the API's
// and the commands' alike. Security events (0.7.3) come with it: sign-in,
// sign-out and session revocation record through it, and so does the import
// of the identity provider's events. So does the access audit of
// confidential reads (0.7.4), which records through the audit service.
@Global()
@Module({
  providers: [AuditService, SecurityEvents, AccessAudit],
  exports: [AuditService, SecurityEvents, AccessAudit],
})
export class AuditModule {}
