import { Global, Module } from '@nestjs/common';
import { ConsumerInboxes } from './consumer-inboxes';
import { Outbox } from './outbox';

// The transactional outbox and the consumer inbox (0.7.5): one service each,
// writing on the caller's transaction. Global, and imported by the
// PrismaModule as audit is, so that they come with every transaction's
// client — the API's, the worker's (0.7.6) and the commands' alike.
@Global()
@Module({
  providers: [Outbox, ConsumerInboxes],
  exports: [Outbox, ConsumerInboxes],
})
export class OutboxModule {}
