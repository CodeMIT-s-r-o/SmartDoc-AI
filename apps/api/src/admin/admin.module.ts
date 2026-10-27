import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminGuard } from './admin.guard.js';
import { AdminRepository } from './admin.repository.js';

@Module({
  controllers: [AdminController],
  providers: [AdminRepository, AdminGuard],
})
export class AdminModule {}
