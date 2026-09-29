import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConversationsRepository } from '../conversations/conversations.repository.js';

const TICK_MS = 60_000;
/** A stream never legitimately runs this long (the AI service times out well before). */
const STALE_AFTER_MS = 2 * 60_000;

/** Closes assistant messages left `streaming` by a crashed or restarted API process. */
@Injectable()
export class ChatHousekeeping implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatHousekeeping.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly repo: ConversationsRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async tick(now: Date = new Date()): Promise<number> {
    try {
      const closed = await this.repo.failStaleStreaming(new Date(now.getTime() - STALE_AFTER_MS));
      if (closed > 0) {
        this.logger.warn(`closed ${closed} stale streaming message(s)`);
      }
      return closed;
    } catch (error) {
      this.logger.warn(`housekeeping failed: ${String(error)}`);
      return 0;
    }
  }
}
