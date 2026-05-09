import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000, // 1 minute
          limit: 5, // 5 attempts per minute
        },
      ],
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottlerConfigModule {}
