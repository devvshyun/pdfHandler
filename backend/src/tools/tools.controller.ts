import { BadRequestException, Body, Controller, Post, Res, StreamableFile, UploadedFile, UploadedFiles, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { parseOperations } from '../common/operation-validation';
import { contentDisposition, decodeFilename, PdfUpload, requireFile } from '../common/upload';
import { PdfWorkerPool } from '../pdf-worker/pdf-worker.pool';
import { RateLimit, RateLimitGuard } from '../rate-limit/rate-limit.guard';

/**
 * Stateless endpoints: nothing is stored, the result is returned directly. Usable without an
 * account, so they are rate-limited per client IP (RATE_LIMIT_TOOLS).
 */
@Controller('tools')
@UseGuards(RateLimitGuard)
@RateLimit('tools')
export class ToolsController {
  constructor(private readonly pool: PdfWorkerPool) {}

  @Post('info')
  @PdfUpload('file')
  async info(@UploadedFile() file: Express.Multer.File | undefined) {
    requireFile(file);
    return (await this.pool.run({ kind: 'info', input: { path: file.path } })).info;
  }

  @Post('merge')
  @PdfUpload('files', true)
  async merge(@UploadedFiles() files: Express.Multer.File[] | undefined, @Res({ passthrough: true }) res: Response) {
    if (!files || files.length < 2) throw new BadRequestException('"files" 필드로 PDF를 2개 이상 업로드하세요.');
    const out = await this.pool.run({ kind: 'merge', inputs: files.map((f) => ({ path: f.path })) });
    return this.send(res, out.bytes, 'merged.pdf');
  }

  /** multipart: `file` + `operations` (JSON string of PdfOperation[]). */
  @Post('apply')
  @PdfUpload('file')
  async apply(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('operations') rawOperations: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireFile(file);
    const operations = parseOperations(rawOperations);
    const out = await this.pool.run({ kind: 'apply', input: { path: file.path }, operations });
    return this.send(res, out.bytes, decodeFilename(file.originalname));
  }

  private send(res: Response, data: Uint8Array, filename: string): StreamableFile {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition(filename) });
    return new StreamableFile(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
}
