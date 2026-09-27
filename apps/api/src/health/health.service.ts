import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import { DB, type Database } from '../db/db.module.js';

export type ComponentStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  db: ComponentStatus;
  ai: ComponentStatus;
  version: string;
}

const AI_HEALTH_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The API is healthy when its database is reachable; the AI service is reported, not required. */
  async check(): Promise<HealthReport> {
    const [db, ai] = await Promise.all([this.checkDb(), this.checkAi()]);
    return {
      status: db === 'up' ? 'ok' : 'error',
      db,
      ai,
      version: this.config.get('APP_VERSION', { infer: true }),
    };
  }

  private async checkDb(): Promise<ComponentStatus> {
    try {
      await this.db.execute(sql`select 1`);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkAi(): Promise<ComponentStatus> {
    try {
      const res = await fetch(`${this.config.get('AI_URL', { infer: true })}/internal/health`, {
        signal: AbortSignal.timeout(AI_HEALTH_TIMEOUT_MS),
      });
      return res.ok ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
