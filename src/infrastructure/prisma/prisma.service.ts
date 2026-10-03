import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'async_hooks';
import { databaseConnectionOf } from './database-url';
import {
  describeError,
  stackFramesOf,
} from '../../common/logging/describe-error';

export interface TenantContext {
  tenantId: string;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly asyncLocalStorage = new AsyncLocalStorage<TenantContext>();
  private pool: Pool;

  constructor(private configService: ConfigService) {
    const databaseUrl = configService.get<string>('DATABASE_URL');

    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // A `schema` parameter selects the schema Prisma names in its queries
    // (the API test harness gives every run its own); pg never sees it.
    const { connectionString, schema } = databaseConnectionOf(databaseUrl);

    // Create a connection pool for the adapter
    const pool = new Pool({
      connectionString,
      max: 10, // Maximum number of connections in the pool
      idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
      connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
    });

    // Create the PostgreSQL adapter
    const adapter = new PrismaPg(pool, schema ? { schema } : undefined);

    // Initialize PrismaClient with the adapter - super() must be called first
    // No `error` level: Prisma's error log prints the failing call and the
    // values it was given. An error reaches its caller as an exception, and
    // the exception filter logs that without its message.
    super({
      adapter,
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'stdout',
          level: 'info',
        },
        {
          emit: 'stdout',
          level: 'warn',
        },
      ],
    });

    // Store pool reference for cleanup after super() call
    this.pool = pool;

    // Set up event listeners for query logging
    // Note: $on type casting is necessary due to Prisma's internal type definitions
    (this as any).$on('query', (e: any) => {
      this.logger.debug(`Query: ${e.query}`);
      this.logger.debug(`Duration: ${e.duration}ms`);
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Successfully connected to database');

      // Note: Prisma 7.x with adapter does not support $use middleware
      // Tenant isolation should be handled at the application/service layer
      // using the runWithTenant method and explicit tenantId filtering
    } catch (error) {
      this.logger.error(
        `Failed to connect to database: ${describeError(error)}`,
        stackFramesOf(error),
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
      await this.pool.end();
      this.logger.log('Successfully disconnected from database');
    } catch (error) {
      this.logger.error(
        `Error during database disconnection: ${describeError(error)}`,
        stackFramesOf(error),
      );
    }
  }

  /**
   * Run a database operation with tenant context
   * This method should be used to wrap service-layer operations that require tenant isolation
   */
  async runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.asyncLocalStorage.run({ tenantId }, fn);
  }

  /**
   * Get current tenant ID from context
   */
  getCurrentTenantId(): string | undefined {
    return this.asyncLocalStorage.getStore()?.tenantId;
  }

  /**
   * Helper method to ensure tenant isolation in queries
   * Service layer should use this to append tenantId to where clauses
   */
  getTenantFilter(tenantId?: string): { tenantId: string } {
    const tid = tenantId || this.getCurrentTenantId();
    if (!tid) {
      throw new Error('Tenant ID is required for this operation');
    }
    return { tenantId: tid };
  }
}
