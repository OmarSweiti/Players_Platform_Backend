import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { NoRateLimit } from '../common/rate-limit/rate-limit.decorator';
import { ReadinessService } from './readiness.service';

/**
 * The probes: unversioned and outside the API prefix (app.setup.ts), since
 * they check the process, not an API version. Neither reveals a version, a
 * host or which dependency failed. Neither is rate-limited: liveness must
 * answer without Valkey, and readiness reports Valkey itself.
 */
@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Public()
  @NoRateLimit()
  @Get('live')
  @ApiOperation({ summary: 'The process is running' })
  live() {
    return { status: 'live' };
  }

  @Public()
  @NoRateLimit()
  @Get('ready')
  @ApiOperation({ summary: 'The process can serve: its dependencies answer' })
  async ready() {
    await this.readiness.check();
    return { status: 'ready' };
  }
}
