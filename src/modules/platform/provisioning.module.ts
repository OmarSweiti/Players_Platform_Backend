import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ProvisioningEnv } from '../../config/env.schema';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { IdentityAdminModule } from '../identity/identity-admin.module';
import { ProvisioningRecords } from './application/ports/provisioning-records.port';
import { ProvisionTenantUseCase } from './application/use-cases/provision-tenant.usecase';
import { ProvisioningRepository } from './infrastructure/repositories/provisioning.repository';

/**
 * The tenant provisioning command's composition (0.5.9): the database, the
 * identity provider's administration, and the use case — no routes, and
 * nothing of the API's sessions or limits. Its settings are validated before
 * it is built (src/cli/provision-tenant.ts), and are the only ones it reads.
 */
@Module({})
export class ProvisioningModule {
  static forSettings(settings: ProvisioningEnv): DynamicModule {
    return {
      module: ProvisioningModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: () => settings,
        }),
        PrismaModule,
        IdentityAdminModule,
      ],
      providers: [
        { provide: ProvisioningRecords, useClass: ProvisioningRepository },
        ProvisionTenantUseCase,
      ],
    };
  }
}
