import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { LoggerModule } from 'nestjs-pino';
import type { Env, WorkerEnv } from '../../config/env.schema';
import {
  accessLogOptions,
  defaultLogSink,
  LOG_SINK,
  type LogSink,
  loggerOptions,
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

/**
 * The worker's logs (0.7.6): the same lines, written as the worker — it serves
 * no request, so there is no access log. Its jobs' lines carry their request
 * id through runCorrelatedJob.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
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
      useFactory: (config: ConfigService<WorkerEnv, true>, sink: LogSink) => {
        const options = loggerOptions(
          'worker',
          config.get('NODE_ENV', { infer: true }),
          // A test's sink sets the level; otherwise LOG_LEVEL may.
          sink.stream
            ? sink.level
            : (config.get('LOG_LEVEL', { infer: true }) ?? sink.level),
        );
        return { pinoHttp: sink.stream ? [options, sink.stream] : options };
      },
    }),
  ],
})
export class WorkerLoggingModule {}
