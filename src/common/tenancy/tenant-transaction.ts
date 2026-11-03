import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  assertAuthorizedTenantContext,
  type AuthorizedTenantContext,
} from './tenant-context';

/** The client a use case's database work runs on: one transaction, on one connection. */
export type TenantTx = Prisma.TransactionClient;

/**
 * The one way a module reaches the database (0.4.3; ADR-0004). Every call
 * opens a transaction, sets `app.tenant_id` on its connection for that
 * transaction only, and runs the work there. Row-level security (0.4.5) reads
 * the setting; repositories still write `tenantId: ctx.tenantId` into their
 * predicates, because the policy is the backstop, not the only filter.
 */
@Injectable()
export class TenantTransactions {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: Pick<PrismaClient, '$transaction'>,
  ) {}

  async withTenantTransaction<T>(
    ctx: AuthorizedTenantContext,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    // A refusal is a rejection like any other failure, and comes before any
    // connection is taken.
    assertAuthorizedTenantContext(ctx);
    return await this.prisma.$transaction(async (tx) => {
      // is_local = true: the setting ends with the transaction, so a pooled
      // connection never carries one tenant into the next piece of work.
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
      return fn(tx);
    });
  }
}
