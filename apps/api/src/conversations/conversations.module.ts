import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module.js';
import { AiClient } from '../chat/ai-client.js';
import { ChatHousekeeping } from '../chat/chat-housekeeping.js';
import { ChatService } from '../chat/chat.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessagesController } from './messages.controller.js';

@Module({
  imports: [BudgetModule],
  controllers: [ConversationsController, MessagesController],
  providers: [ConversationsRepository, ChatService, AiClient, ChatHousekeeping],
})
export class ConversationsModule {}
