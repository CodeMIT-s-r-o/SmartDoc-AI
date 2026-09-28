import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from './auth-context.js';

/** Rate limits per authenticated user (Cognito `sub`), falling back to the client IP. */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: AuthenticatedRequest): Promise<string> {
    return Promise.resolve(req.auth ? `tenant:${req.auth.tenantId}` : `ip:${req.ip ?? 'unknown'}`);
  }
}
