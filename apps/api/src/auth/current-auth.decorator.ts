import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthContext, AuthenticatedRequest } from './auth-context.js';

/** Injects the caller's AuthContext; only valid on routes behind AuthGuard. */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    if (!auth) {
      throw new Error('CurrentAuth used on a route without AuthGuard');
    }
    return auth;
  },
);
