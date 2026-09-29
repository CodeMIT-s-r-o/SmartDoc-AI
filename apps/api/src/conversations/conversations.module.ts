import { Module } from '@nestjs/common';
import { AiClient } from '../chat/ai-client.js';
import { ChatHousekeeping } from '../chat/chat-housekeeping.js';
import { ChatService } from '../chat/chat.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsRepository } from './conversations.repository.js';

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsRepository, ChatService, AiClient, ChatHousekeeping],
})
export class ConversationsModule {}
