import { Controller, Get } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { UsersService, type MeResponse } from './users.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.users.getMe(auth);
  }
}
