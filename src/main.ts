import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { Env } from './config/env.schema';
import { setupSwagger } from './config/swagger';

async function bootstrap() {
  // The environment is validated as AppModule loads (src/config/env.schema.ts):
  // a missing or invalid variable stops the process here, naming the variable.
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const logger = new Logger('Bootstrap');

  const apiPrefix = configureApp(app);
  const swagger = setupSwagger(app, config.get('NODE_ENV', { infer: true }));

  // Shutdown hooks for graceful shutdown
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  if (swagger) logger.log(`API documentation: http://localhost:${port}/docs`);
  logger.log(`Health check: http://localhost:${port}/${apiPrefix}/health`);
}
void bootstrap();
