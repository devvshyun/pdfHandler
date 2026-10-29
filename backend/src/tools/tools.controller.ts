import { BadRequestException, Body, Controller, Post, Res, StreamableFile, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { applyOperations, getPdfInfo, mergePdfs, OPERATION_TYPES, PdfOperation } from '@pdfhandler/core';
import { Response } from 'express';
import { PdfFontProvider } from '../common/pdf-font.provider';
import { assertPdfUpload, contentDisposition, decodeFilename } from '../common/upload';

/** Stateless endpoints: nothing is stored, the result is returned directly. */
@Controller('tools')
export class ToolsController {
  constructor(private readonly fonts: PdfFontProvider) {}

  @Post('info')
  @UseInterceptors(FileInterceptor('file'))
  info(@UploadedFile() file: Express.Multer.File | undefined) {
    assertPdfUpload(file);
    return getPdfInfo(new Uint8Array(file.buffer));
  }

  @Post('merge')
  @UseInterceptors(FilesInterceptor('files', 50))
  async merge(@UploadedFiles() files: Express.Multer.File[] | undefined, @Res({ passthrough: true }) res: Response) {
    if (!files || files.length < 2) throw new BadRequestException('"files" 필드로 PDF를 2개 이상 업로드하세요.');
    files.forEach((f) => assertPdfUpload(f));
    const out = await mergePdfs(files.map((f) => new Uint8Array(f.buffer)));
    return this.send(res, out, 'merged.pdf');
  }

  /** multipart: `file` + `operations` (JSON string of PdfOperation[]). */
  @Post('apply')
  @UseInterceptors(FileInterceptor('file'))
  async apply(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('operations') rawOperations: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertPdfUpload(file);
    const operations = parseOperations(rawOperations);
    const out = await applyOperations(new Uint8Array(file.buffer), operations, { font: this.fonts.font });
    return this.send(res, out, decodeFilename(file.originalname));
  }

  private send(res: Response, data: Uint8Array, filename: string): StreamableFile {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition(filename) });
    return new StreamableFile(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
}

function parseOperations(raw: string | undefined): PdfOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new BadRequestException('"operations"는 JSON 배열 문자열이어야 합니다.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new BadRequestException('"operations"가 비어 있습니다.');
  for (const op of parsed) {
    if (typeof op !== 'object' || op === null || !OPERATION_TYPES.includes((op as PdfOperation).type)) {
      throw new BadRequestException(`알 수 없는 작업: ${JSON.stringify(op)}`);
    }
  }
  return parsed as PdfOperation[];
}
