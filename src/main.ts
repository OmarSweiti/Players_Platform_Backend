import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { answerUnknownPaths, configureApp } from './app.setup';
import type { Env } from './config/env.schema';
import { setupSwagger } from './config/swagger';

async function bootstrap() {
  // The environment is validated as AppModule loads (src/config/env.schema.ts):
  // a missing or invalid variable stops the process here, naming the variable.
  // Nest's own lines wait for the structured logger (configureApp).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const logger = new Logger('Bootstrap');

  configureApp(app);
  const swagger = setupSwagger(app, config.get('NODE_ENV', { infer: true }));

  // Shutdown hooks for graceful shutdown
  app.enableShutdownHooks();

  // Every route is registered once the app is initialised; what none serves
  // comes last.
  await app.init();
  answerUnknownPaths(app);

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  if (swagger) logger.log(`API documentation: http://localhost:${port}/docs`);
  logger.log(`Probes: http://localhost:${port}/health/live and /health/ready`);
}
void bootstrap();
