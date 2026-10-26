import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/validation.js';
import { AdminGuard } from './admin.guard.js';
import { AdminRepository } from './admin.repository.js';

const DAY_MS = 86_400_000;

const metricsQuery = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to' });

/** The Cost page (docs/IMPLEMENTATION_PLAN.md §8): ledger-backed numbers, admins only. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly repo: AdminRepository) {}

  /** Defaults to the last 30 days; `to` is inclusive (whole UTC day). */
  @Get('metrics')
  metrics(@Query(new ZodValidationPipe(metricsQuery)) query: z.infer<typeof metricsQuery>) {
    const to = query.to ? new Date(Date.parse(query.to) + DAY_MS) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    return this.repo.metrics({ from, to });
  }

  @Get('feedback')
  feedback() {
    return this.repo.thumbsDown(50);
  }
}
