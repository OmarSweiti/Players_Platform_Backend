import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { parseWorkerEnv } from './config/env.schema';
import { WorkerLifecycle, WorkerModule } from './worker.module';

// The worker process (0.7.6; docs/reference/architecture.md): a second entry
// point of the same codebase and image, beside the API. It relays the
// transactional outbox to the queue and runs the queue's jobs, each in its own
// tenant's transaction.
//
//   npm run build && npm run start:worker
//
// It reads its own settings (WorkerEnv: the runtime role's database, the
// registry role's, Valkey), from the environment and, as the API does, .env —
// none of the API's secrets. On SIGTERM or SIGINT it stops relaying, drains
// the jobs running, and only then closes its connections.

async function bootstrap(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  let settings;
  try {
    settings = parseWorkerEnv(process.env);
  } catch (error) {
    process.stderr.write(`worker: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forSettings(settings),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  const lifecycle = app.get(WorkerLifecycle);
  lifecycle.start();
  app.get(Logger).log('the worker is relaying the outbox and running its jobs');

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.get(Logger).log(`${signal}: draining the jobs running, then stopping`);
    void lifecycle
      .stop()
      .then(() => app.close())
      .then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          process.stderr.write(
            `worker: the shutdown failed: ${(error as Error).name}\n`,
          );
          process.exitCode = 1;
        },
      );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

void bootstrap();
