import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CognitoUserInfoClient } from './user-info.client.js';
import { UsersRepository } from './users.repository.js';

export interface MeResponse {
  id: string;
  email: string;
  isAdmin: boolean;
  dailyLimitUsd: number;
  spentTodayUsd: number;
}

/** last_seen_at is written at most this often per user, to keep auth off the DB hot path. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class UsersService {
  /** sub -> when last_seen_at was last written. Invite-only, so the map stays small. */
  private readonly lastSeenWrites = new Map<string, number>();

  constructor(
    private readonly repo: UsersRepository,
    private readonly userInfo: CognitoUserInfoClient,
  ) {}

  /** Creates the users row on a user's first request (email from Cognito userInfo). */
  async ensureUser(auth: AuthContext): Promise<void> {
    const now = Date.now();
    const lastWrite = this.lastSeenWrites.get(auth.tenantId);
    if (lastWrite !== undefined && now - lastWrite < LAST_SEEN_WRITE_INTERVAL_MS) {
      return;
    }
    const exists = await this.repo.touch(auth.tenantId);
    if (!exists) {
      const email = await this.userInfo.getEmail(auth.accessToken);
      await this.repo.insert({ id: auth.tenantId, email });
    }
    this.lastSeenWrites.set(auth.tenantId, now);
  }

  async getMe(auth: AuthContext): Promise<MeResponse> {
    const profile = await this.repo.getProfile(auth.tenantId);
    if (!profile) {
      throw new NotFoundException('User not found');
    }
    return {
      id: auth.tenantId,
      email: profile.email,
      isAdmin: auth.isAdmin,
      dailyLimitUsd: Number(profile.dailyLimitUsd),
      spentTodayUsd: Number(profile.spentTodayUsd ?? 0),
    };
  }
}
