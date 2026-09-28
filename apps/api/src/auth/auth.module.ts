import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AccessTokenVerifier } from './access-token-verifier.js';
import { AuthGuard } from './auth.guard.js';
import { TenantThrottlerGuard } from './tenant-throttler.guard.js';

@Module({
  imports: [UsersModule],
  providers: [AccessTokenVerifier, AuthGuard, TenantThrottlerGuard],
  exports: [AccessTokenVerifier, AuthGuard, TenantThrottlerGuard],
})
export class AuthModule {}
