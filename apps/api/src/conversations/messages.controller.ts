import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { type FeedbackRequest, feedbackRequestSchema } from '@smartdoc/contracts';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ProblemException } from '../common/problem.js';
import { uuidParam, ZodValidationPipe } from '../common/validation.js';
import { ConversationsRepository } from './conversations.repository.js';

const notFound = () => new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Answer not found');

/** Thumbs on an answer: one rating per message, changeable and removable. */
@Controller('messages')
export class MessagesController {
  constructor(private readonly repo: ConversationsRepository) {}

  @Post(':id/feedback')
  @HttpCode(204)
  async rate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Answer')) id: string,
    @Body(new ZodValidationPipe(feedbackRequestSchema)) body: FeedbackRequest,
  ): Promise<void> {
    if (!(await this.repo.saveFeedback(auth.tenantId, id, body))) {
      throw notFound();
    }
  }

  @Delete(':id/feedback')
  @HttpCode(204)
  async unrate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Answer')) id: string,
  ): Promise<void> {
    if (!(await this.repo.deleteFeedback(auth.tenantId, id))) {
      throw notFound();
    }
  }
}
