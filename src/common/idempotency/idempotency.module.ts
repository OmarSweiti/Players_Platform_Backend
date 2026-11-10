import { Global, Module } from '@nestjs/common';
import { TenantTransactions } from '../tenancy/tenant-transaction';
import { IDEMPOTENCY, Idempotency } from './idempotency';

// Idempotency keys for retried commands (0.7.7): one service, on the tenant
// transactions the global PrismaModule provides. Global, so that a module's
// use case takes it as it takes the outbox; the API's alone — the worker runs
// no member's command.
@Global()
@Module({
  providers: [
    {
      provide: Idempotency,
      useFactory: (transactions: TenantTransactions) =>
        new Idempotency(transactions, IDEMPOTENCY),
      inject: [TenantTransactions],
    },
  ],
  exports: [Idempotency],
})
export class IdempotencyModule {}
