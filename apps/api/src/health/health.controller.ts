import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator.js';
import { HealthService, type HealthReport } from './health.service.js';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Always the full report (not problem+json), with 503 when the database is down. */
  @Get()
  async check(
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
