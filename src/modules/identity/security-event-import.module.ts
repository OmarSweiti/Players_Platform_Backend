import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { EventImportEnv } from '../../config/env.schema';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { ProviderSecurityEvents } from './application/ports/provider-security-events.port';
import { ImportProviderSecurityEventsUseCase } from './application/use-cases/import-provider-security-events.usecase';
import { KeycloakProviderSecurityEvents } from './infrastructure/keycloak/keycloak-provider-security-events';

/**
 * The security-event import's composition (0.7.3): the database, with the
 * security events that come with it, the provider's events as the event
 * reader reads them, and the use case — no routes, and nothing of the API's
 * sessions or limits. Its settings are validated before it is built
 * (src/cli/import-security-events.ts), and are the only ones it reads.
 */
@Module({})
export class SecurityEventImportModule {
  static forSettings(settings: EventImportEnv): DynamicModule {
    return {
      module: SecurityEventImportModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: () => settings,
        }),
        PrismaModule,
      ],
      providers: [
        {
          provide: ProviderSecurityEvents,
          useClass: KeycloakProviderSecurityEvents,
        },
        ImportProviderSecurityEventsUseCase,
      ],
    };
  }
}
