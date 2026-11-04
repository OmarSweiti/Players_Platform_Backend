import { Global, Module } from '@nestjs/common';
import { TenantResolver } from '../../common/tenancy/tenant-resolver';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { PrismaService } from './prisma.service';

// PrismaService is the root client, for the infrastructure that needs one
// (readiness, the tenant registry). Modules use TenantTransactions (0.4.3);
// before sign-in, TenantResolver finds the tenant of the host (0.5.2).
@Global()
@Module({
  providers: [PrismaService, TenantTransactions, TenantResolver],
  exports: [PrismaService, TenantTransactions, TenantResolver],
})
export class PrismaModule {}
