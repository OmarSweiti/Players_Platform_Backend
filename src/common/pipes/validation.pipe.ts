import {
  Injectable,
  ValidationPipe as NestValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';

@Injectable()
export class ValidationPipe extends NestValidationPipe {
  constructor(config: ConfigService<Env, true>) {
    super({
      whitelist: true, // Strip properties that don't have decorators
      forbidNonWhitelisted: true, // Throw error if non-whitelisted values are provided
      transform: true, // Auto-transform payloads to DTO instances
      disableErrorMessages:
        config.get('NODE_ENV', { infer: true }) === 'production',
    });
  }
}
