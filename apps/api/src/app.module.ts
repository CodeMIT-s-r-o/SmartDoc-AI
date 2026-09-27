import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    // Configuration comes from the process environment (compose, CI, prod), never a local .env file.
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
    DbModule,
    HealthModule,
  ],
})
export class AppModule {}
