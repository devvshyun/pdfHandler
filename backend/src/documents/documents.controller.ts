import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard, DocumentScope, Scope } from '../auth/auth.guard';
import { validateOperations } from '../common/operation-validation';
import { contentDisposition, decodeFilename, PdfUpload, requireFile } from '../common/upload';
import { RateLimit, RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { DocumentsService } from './documents.service';
import {
  ApplyOperationsBody,
  ListDocumentsQuery,
  UpdateDocumentBody,
  UploadDocumentBody,
  UploadVersionBody,
} from './dto/documents.dto';

/**
 * Every route is scoped to the caller's own documents (AuthGuard → @Scope()). Documents of other
 * users answer 404 exactly like ids that do not exist.
 */
@Controller('documents')
@UseGuards(AuthGuard, RateLimitGuard)
@RateLimit('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @PdfUpload('file')
  upload(@Scope() scope: DocumentScope, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: UploadDocumentBody) {
    requireFile(file);
    return this.documents.create(scope, file, decodeFilename(file.originalname), body.title);
  }

  @Get()
  list(@Scope() scope: DocumentScope, @Query() query: ListDocumentsQuery) {
    return this.documents.list(scope, query);
  }

  @Get(':id')
  get(@Scope() scope: DocumentScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(scope, id);
  }

  @Patch(':id')
  rename(@Scope() scope: DocumentScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDocumentBody) {
    return this.documents.rename(scope, id, body.title);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Scope() scope: DocumentScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.remove(scope, id);
  }

  /** Downloads the current version, or `?version=N`. Add `?download=1` to force a save dialog. */
  @Get(':id/file')
  async file(
    @Scope() scope: DocumentScope,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('version', new ParseIntPipe({ optional: true })) version: number | undefined,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stream, size, filename } = await this.documents.openFile(scope, id, version);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(filename, !download),
      // Private: the response depends on the Authorization header. Old versions can be deleted,
      // so they are no longer marked immutable.
      'Cache-Control': 'private, no-cache',
      Vary: 'Authorization',
    });
    return new StreamableFile(stream);
  }

  /** Saves a PDF edited in the browser as the next version. */
  @Post(':id/versions')
  @PdfUpload('file')
  addVersion(
    @Scope() scope: DocumentScope,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadVersionBody,
  ) {
    requireFile(file);
    return this.documents.addClientVersion(scope, id, file, body.note);
  }

  /** Deletes every version except the current one (their files are removed from storage). */
  @Post(':id/versions/purge')
  @HttpCode(200)
  purgeVersions(@Scope() scope: DocumentScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.purgeVersions(scope, id);
  }

  /** Deletes one old version; the current version cannot be deleted. Numbers are not reused. */
  @Delete(':id/versions/:version')
  deleteVersion(
    @Scope() scope: DocumentScope,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.documents.deleteVersion(scope, id, version);
  }

  /** Runs pdf operations server-side (in a worker thread) against the current version. */
  @Post(':id/operations')
  applyOperations(@Scope() scope: DocumentScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: ApplyOperationsBody) {
    return this.documents.applyOperations(scope, id, validateOperations(body.operations), body.note);
  }

  @Post(':id/versions/:version/revert')
  revert(@Scope() scope: DocumentScope, @Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.documents.revert(scope, id, version);
  }
}
