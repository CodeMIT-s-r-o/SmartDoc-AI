import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ChatService } from '../chat/chat.service.js';
import type { SseResponse } from '../chat/sse-response.js';
import { ProblemException } from '../common/problem.js';
import { uuidParam, ZodValidationPipe } from '../common/validation.js';
import {
  type ConversationDto,
  createConversationSchema,
  type MessageDto,
  renameConversationSchema,
  type SendMessageBody,
  sendMessageSchema,
  toConversationDto,
  toMessageDto,
} from './conversations.dto.js';
import { ConversationsRepository } from './conversations.repository.js';

export const CHATS_PER_MINUTE = 30;
const notFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found');

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly repo: ConversationsRepository,
    private readonly chat: ChatService,
  ) {}

  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createConversationSchema)) body: { title?: string },
  ): Promise<ConversationDto> {
    return toConversationDto(await this.repo.create(auth.tenantId, body.title ?? null));
  }

  @Get()
  async list(@CurrentAuth() auth: AuthContext): Promise<ConversationDto[]> {
    return (await this.repo.list(auth.tenantId, 50)).map(toConversationDto);
  }

  @Get(':id')
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Conversation')) id: string,
  ): Promise<{ conversation: ConversationDto; messages: MessageDto[] }> {
    const conversation = await this.repo.findOwned(auth.tenantId, id);
    if (!conversation) {
      throw notFound();
    }
    const messages = await this.repo.listMessages(id);
    return { conversation: toConversationDto(conversation), messages: messages.map(toMessageDto) };
  }

  @Patch(':id')
  async rename(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Conversation')) id: string,
    @Body(new ZodValidationPipe(renameConversationSchema)) body: { title: string },
  ): Promise<ConversationDto> {
    const row = await this.repo.rename(auth.tenantId, id, body.title);
    if (!row) {
      throw notFound();
    }
    return toConversationDto(row);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Conversation')) id: string,
  ): Promise<void> {
    if (!(await this.repo.remove(auth.tenantId, id))) {
      throw notFound();
    }
  }

  /** SSE: ack, meta, sources, token..., then done or error. A repeated clientMessageId: JSON. */
  @Post(':id/messages')
  @Throttle({ default: { limit: CHATS_PER_MINUTE, ttl: 60_000 } })
  send(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Conversation')) id: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageBody,
    @Res() res: SseResponse,
  ): Promise<void> {
    return this.chat.send(auth, id, body, res);
  }
}
