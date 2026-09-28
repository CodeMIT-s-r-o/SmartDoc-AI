import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';
import { CognitoUserInfoClient } from './user-info.client.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [MeController],
  providers: [UsersRepository, UsersService, CognitoUserInfoClient],
  exports: [UsersService],
})
export class UsersModule {}
