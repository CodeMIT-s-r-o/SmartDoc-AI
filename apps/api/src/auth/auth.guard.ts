import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersService } from '../users/users.service.js';
import { AccessTokenVerifier } from './access-token-verifier.js';
import type { AuthContext, AuthenticatedRequest } from './auth-context.js';
import { IS_PUBLIC } from './public.decorator.js';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/**
 * Global guard: every route requires a valid Cognito access token unless marked @Public().
 * Registered before the throttler, so rate limits are tracked per user rather than per IP.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let auth: AuthContext;
    try {
      const claims = await this.verifier.verify(token);
      auth = { tenantId: claims.sub, isAdmin: claims.groups.includes('admin'), accessToken: token };
    } catch {
      // Never echo verifier details (which check failed) back to the caller.
      throw new UnauthorizedException('Invalid access token');
    }

    await this.users.ensureUser(auth);
    request.auth = auth;
    return true;
  }
}
