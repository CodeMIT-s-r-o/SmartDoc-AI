import { Module } from '@nestjs/common';
import { BudgetService, type Clock, CLOCK } from './budget.service.js';

@Module({
  providers: [BudgetService, { provide: CLOCK, useValue: (() => new Date()) satisfies Clock }],
  exports: [BudgetService],
})
export class BudgetModule {}
