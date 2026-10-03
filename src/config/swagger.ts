import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Env } from './env.schema';

/**
 * Serves the API description at /docs — in development only, and only when
 * NODE_ENV says so explicitly: staging and production never publish it.
 * Returns whether it is served.
 */
export function setupSwagger(
  app: INestApplication,
  nodeEnv: Env['NODE_ENV'],
): boolean {
  if (nodeEnv !== 'development') return false;

  const config = new DocumentBuilder()
    .setTitle('Football Management Platform API')
    .setDescription('API documentation for the Football Management Platform')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('Authentication', 'User authentication endpoints')
    .addTag('Health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
  return true;
}
