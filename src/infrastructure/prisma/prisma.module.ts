import { Global, Module } from '@nestjs/common';
import { AuthBootstrap } from '../../common/tenancy/auth-bootstrap';
import { TenantResolver } from '../../common/tenancy/tenant-resolver';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrismaService } from './prisma.service';

// PrismaService is the root client, for the infrastructure that needs one
// (readiness, the tenant registry). Modules use TenantTransactions (0.4.3);
// before sign-in, TenantResolver finds the tenant of the host (0.5.2), and
// AuthBootstrap reads and writes there only what sign-in needs (0.5.5). Audit
// comes with them (0.7.2): sign-in's acceptance records through it, and so does
// every use case in the transaction it writes on. So does the outbox (0.7.5),
// and the consumer inbox its consumers record their receipts in.
@Global()
@Module({
  imports: [AuditModule, OutboxModule],
  providers: [PrismaService, TenantTransactions, TenantResolver, AuthBootstrap],
  exports: [PrismaService, TenantTransactions, TenantResolver, AuthBootstrap],
})
export class PrismaModule {}
