import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { uuidParam, ZodValidationPipe } from '../common/validation.js';
import {
  type CreateDocumentBody,
  type CreateDocumentResponse,
  createDocumentSchema,
  type DocumentDto,
  type FileUrlResponse,
} from './documents.dto.js';
import { DocumentsService } from './documents.service.js';

export const UPLOADS_PER_HOUR = 10;

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Step 1: reserve a document and get a presigned POST for the browser. */
  @Post()
  @Throttle({ default: { limit: UPLOADS_PER_HOUR, ttl: 60 * 60 * 1000 } })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentBody,
  ): Promise<CreateDocumentResponse> {
    return this.documents.create(auth, body);
  }

  /** Step 2, after the browser uploaded to S3: validate the object and queue ingestion. */
  @Post(':id/complete')
  @HttpCode(202)
  complete(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Document')) id: string,
  ): Promise<DocumentDto> {
    return this.documents.complete(auth, id);
  }

  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<DocumentDto[]> {
    return this.documents.list(auth);
  }

  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Document')) id: string,
  ): Promise<DocumentDto> {
    return this.documents.get(auth, id);
  }

  @Get(':id/file')
  file(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam('Document')) id: string,
  ): Promise<FileUrlResponse> {
    return this.documents.fileUrl(auth, id);
  }
}
