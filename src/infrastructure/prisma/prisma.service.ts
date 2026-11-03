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
import { databaseConnectionOf } from './database-url';
import {
  describeError,
  stackFramesOf,
} from '../../common/logging/describe-error';
import type { Env } from '../../config/env.schema';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private pool: Pool;

  constructor(config: ConfigService<Env, true>) {
    const databaseUrl = config.get('DATABASE_URL', { infer: true });

    // A `schema` parameter selects the schema Prisma names in its queries
    // (the API test harness gives every run its own), and the search_path of
    // every connection, so raw SQL runs in it too (database-url.ts).
    const { connectionString, schema, options } =
      databaseConnectionOf(databaseUrl);

    // Create a connection pool for the adapter
    const pool = new Pool({
      connectionString,
      options,
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
      // Tenant work never runs on this client directly: modules go through
      // TenantTransactions.withTenantTransaction (src/common/tenancy, 0.4.3).
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
}
