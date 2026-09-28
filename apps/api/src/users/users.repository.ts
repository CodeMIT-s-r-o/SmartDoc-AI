import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { userDailyUsage, users } from '../db/schema.js';

export interface UserProfile {
  email: string;
  dailyLimitUsd: string;
  spentTodayUsd: string | null;
}

/** Budget days follow the same calendar as the ledger trigger. */
const TODAY = sql`(now() AT TIME ZONE 'Europe/Bratislava')::date`;

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Updates last_seen_at; returns false when the user does not exist yet. */
  async touch(id: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** Idempotent: concurrent first requests of the same user insert once. */
  async insert(user: { id: string; email: string }): Promise<void> {
    await this.db
      .insert(users)
      .values({ ...user, lastSeenAt: sql`now()` })
      .onConflictDoNothing();
  }

  async getProfile(id: string): Promise<UserProfile | undefined> {
    const [row] = await this.db
      .select({
        email: users.email,
        dailyLimitUsd: users.dailyLimitUsd,
        spentTodayUsd: userDailyUsage.spentUsd,
      })
      .from(users)
      .leftJoin(
        userDailyUsage,
        and(eq(userDailyUsage.tenantId, users.id), eq(userDailyUsage.day, TODAY)),
      )
      .where(eq(users.id, id));
    return row;
  }
}
