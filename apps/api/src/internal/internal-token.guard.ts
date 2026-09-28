import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth/auth-context.js';
import type { Env } from '../config/env.js';

/** Service-to-service auth: the shared X-Internal-Token, compared in constant time. */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService<Env, true>) {
    this.expected = Buffer.from(config.get('INTERNAL_TOKEN', { infer: true }));
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<AuthenticatedRequest>().headers[
      'x-internal-token'
    ];
    const given = Buffer.from(typeof header === 'string' ? header : '');
    if (given.length !== this.expected.length || !timingSafeEqual(given, this.expected)) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}
