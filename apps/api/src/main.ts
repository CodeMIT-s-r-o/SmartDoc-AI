import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // Lets req.ip (the throttler key for anonymous calls) see the viewer, not the proxy.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
