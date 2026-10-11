import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ReadinessService } from './readiness.service';

/**
 * The probes: unversioned and outside the API prefix (app.setup.ts), since
 * they check the process, not an API version. Neither reveals a version, a
 * host or which dependency failed.
 */
@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'The process is running' })
  live() {
    return { status: 'live' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'The process can serve: its dependencies answer' })
  async ready() {
    await this.readiness.check();
    return { status: 'ready' };
  }
}
