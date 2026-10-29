import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentVersion } from './entities/document-version.entity';
import { PdfDocument } from './entities/pdf-document.entity';

@Module({
  imports: [MikroOrmModule.forFeature([PdfDocument, DocumentVersion])],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
