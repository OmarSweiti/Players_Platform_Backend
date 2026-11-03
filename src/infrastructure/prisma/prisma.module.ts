import { Global, Module } from '@nestjs/common';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { PrismaService } from './prisma.service';

// PrismaService is the root client, for the infrastructure that needs one
// (readiness, the tenant registry). Modules use TenantTransactions (0.4.3).
@Global()
@Module({
  providers: [PrismaService, TenantTransactions],
  exports: [PrismaService, TenantTransactions],
})
export class PrismaModule {}
