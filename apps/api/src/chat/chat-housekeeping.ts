import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BudgetService } from '../budget/budget.service.js';
import { ConversationsRepository } from '../conversations/conversations.repository.js';

const TICK_MS = 60_000;
/** A stream never legitimately runs this long (the AI service times out well before). */
const STALE_AFTER_MS = 2 * 60_000;

/**
 * Cleans up after a crashed or restarted API process: closes assistant messages left `streaming`
 * and releases budget reservations that were never released.
 */
@Injectable()
export class ChatHousekeeping implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatHousekeeping.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repo: ConversationsRepository,
    private readonly budget: BudgetService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async tick(now: Date = new Date()): Promise<{ messages: number; reservations: number }> {
    const result = { messages: 0, reservations: 0 };
    try {
      result.messages = await this.repo.failStaleStreaming(
        new Date(now.getTime() - STALE_AFTER_MS),
      );
      if (result.messages > 0) {
        this.logger.warn(`closed ${result.messages} stale streaming message(s)`);
      }
      result.reservations = await this.budget.releaseExpired();
    } catch (error) {
      this.logger.warn(`housekeeping failed: ${String(error)}`);
    }
    return result;
  }
}
