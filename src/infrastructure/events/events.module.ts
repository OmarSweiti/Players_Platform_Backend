import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventService } from './event.service';
import type { Env } from '../../config/env.schema';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService<Env, true>) => {
        // Read first: inside the literal, BullMQ 6's connection union would
        // infer `get`'s result as any.
        const host = config.get('REDIS_HOST', { infer: true });
        const port = config.get('REDIS_PORT', { infer: true });
        return { connection: { host, port } };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: 'notifications' }, { name: 'audit-logs' }),
  ],
  providers: [EventService],
  exports: [EventService],
})
export class EventsModule {}
