import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';
import {
  accessLogOptions,
  defaultLogSink,
  LOG_SINK,
  type LogSink,
} from './logger-options';

/**
 * Structured logs (0.10.1): pino writes one JSON line per event — Nest's own
 * logs too, once app.setup.ts installs its logger — and pino-http writes the
 * access log. nestjs-pino keeps one logger per process, built by the first
 * application that starts in it.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync<Request, Response>({
      imports: [ConfigModule],
      providers: [
        {
          provide: LOG_SINK,
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) =>
            defaultLogSink(config.get('NODE_ENV', { infer: true })),
        },
      ],
      inject: [ConfigService, LOG_SINK],
      useFactory: (config: ConfigService<Env, true>, sink: LogSink) => {
        const options = accessLogOptions(
          config.get('NODE_ENV', { infer: true }),
          sink.level,
        );
        return { pinoHttp: sink.stream ? [options, sink.stream] : options };
      },
    }),
  ],
})
export class LoggingModule {}
