import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth-context.js';
import { ProblemException } from '../common/problem.js';

/** Members of the Cognito `admin` group only; everyone else gets 403 (they know the page exists). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context.switchToHttp().getRequest<AuthenticatedRequest>().auth?.isAdmin) {
      throw new ProblemException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Admins only');
    }
    return true;
  }
}
