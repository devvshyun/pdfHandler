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
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { assertPdfUpload, contentDisposition, decodeFilename } from '../common/upload';
import { DocumentsService } from './documents.service';
import {
  ApplyOperationsBody,
  ListDocumentsQuery,
  UpdateDocumentBody,
  UploadDocumentBody,
  UploadVersionBody,
} from './dto/documents.dto';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: UploadDocumentBody) {
    assertPdfUpload(file);
    return this.documents.create(new Uint8Array(file.buffer), decodeFilename(file.originalname), body.title);
  }

  @Get()
  list(@Query() query: ListDocumentsQuery) {
    return this.documents.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(id);
  }

  @Patch(':id')
  rename(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDocumentBody) {
    return this.documents.rename(id, body.title);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.remove(id);
  }

  /** Downloads the current version, or `?version=N`. Add `?download=1` to force a save dialog. */
  @Get(':id/file')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('version', new ParseIntPipe({ optional: true })) version: number | undefined,
    @Query('download') download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stream, size, filename } = await this.documents.openFile(id, version);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(filename, !download),
      'Cache-Control': version ? 'private, max-age=31536000, immutable' : 'no-cache',
    });
    return new StreamableFile(stream);
  }

  /** Saves a PDF edited in the browser as the next version. */
  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file'))
  addVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadVersionBody,
  ) {
    assertPdfUpload(file);
    return this.documents.addClientVersion(id, new Uint8Array(file.buffer), body.note);
  }

  /** Runs pdf operations server-side against the current version. */
  @Post(':id/operations')
  applyOperations(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApplyOperationsBody) {
    return this.documents.applyOperations(id, body.operations, body.note);
  }

  @Post(':id/versions/:version/revert')
  revert(@Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.documents.revert(id, version);
  }
}
