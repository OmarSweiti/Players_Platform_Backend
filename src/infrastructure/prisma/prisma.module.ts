import { Global, Module } from '@nestjs/common';
import { AuthBootstrap } from '../../common/tenancy/auth-bootstrap';
import { TenantResolver } from '../../common/tenancy/tenant-resolver';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { PrismaService } from './prisma.service';

// PrismaService is the root client, for the infrastructure that needs one
// (readiness, the tenant registry). Modules use TenantTransactions (0.4.3);
// before sign-in, TenantResolver finds the tenant of the host (0.5.2), and
// AuthBootstrap reads and writes there only what sign-in needs (0.5.5).
@Global()
@Module({
  providers: [PrismaService, TenantTransactions, TenantResolver, AuthBootstrap],
  exports: [PrismaService, TenantTransactions, TenantResolver, AuthBootstrap],
})
export class PrismaModule {}
