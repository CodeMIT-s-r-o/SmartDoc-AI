import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantThrottlerGuard } from './auth/tenant-throttler.guard.js';
import { ProblemJsonFilter } from './common/problem-json.filter.js';
import { type Env, validateEnv } from './config/env.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { DbModule } from './db/db.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthModule } from './health/health.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    // Configuration comes from the process environment (compose, CI, prod), never a local .env file.
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [
        { ttl: 60_000, limit: config.get('THROTTLE_LIMIT_PER_MINUTE', { infer: true }) },
      ],
    }),
    DbModule,
    AuthModule,
    UsersModule,
    DocumentsModule,
    ConversationsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemJsonFilter },
    // Order matters: authenticate first, so the throttler can track by user.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useExisting: TenantThrottlerGuard },
  ],
})
export class AppModule {}
