import { Module } from '@nestjs/common';
import { InternalDocumentsController } from '../internal/internal-documents.controller.js';
import { InternalTokenGuard } from '../internal/internal-token.guard.js';
import { DocumentStorage } from '../storage/document-storage.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentsService } from './documents.service.js';

@Module({
  controllers: [DocumentsController, InternalDocumentsController],
  providers: [DocumentsRepository, DocumentsService, DocumentStorage, InternalTokenGuard],
})
export class DocumentsModule {}
