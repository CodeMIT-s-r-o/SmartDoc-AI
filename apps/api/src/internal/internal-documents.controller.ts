import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator.js';
import { uuidParam } from '../common/validation.js';
import { DocumentsService } from '../documents/documents.service.js';
import type { SignedUrl } from '../storage/document-storage.js';
import { InternalTokenGuard } from './internal-token.guard.js';

/**
 * Routes for the Python worker. Outside the /api prefix (see app.setup.ts), not behind Cognito
 * auth but behind the internal token, and never forwarded by the edge proxy.
 */
@Public()
@SkipThrottle()
@UseGuards(InternalTokenGuard)
@Controller('internal/documents')
export class InternalDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** A 5-minute GET for the exact object version validated at /complete. */
  @Post(':id/download-url')
  @HttpCode(200)
  downloadUrl(@Param('id', uuidParam('Document')) id: string): Promise<SignedUrl> {
    return this.documents.ingestionDownloadUrl(id);
  }
}
