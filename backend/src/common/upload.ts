import {
  applyDecorators,
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  PayloadTooLargeException,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { isPdf } from '@pdfhandler/core';
import { Request, Response } from 'express';
import { open, rm } from 'node:fs/promises';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import { AppConfig } from '../config/configuration';

/**
 * Upload strategy: multer writes every file to UPLOAD_TMP_DIR (disk storage, never RAM), and
 * the PDF work reads them inside a worker thread. Limits:
 *   - per file: MAX_UPLOAD_MB (multer `fileSize`)
 *   - files per request: MAX_MERGE_FILES (multer `files`)
 *   - whole request: MAX_REQUEST_MB — checked from Content-Length before multer reads the body,
 *     and again on the sum of stored file sizes (covers chunked bodies without Content-Length).
 * Temp files are removed when the handler finishes, successfully or not (multer itself removes
 * partial files when it aborts).
 */
@Injectable()
export class UploadLimitsInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Upload');

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { maxTotalBytes } = this.config.get('upload', { infer: true });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxTotalBytes) {
      // The body is never read; close the connection instead of draining it.
      context.switchToHttp().getResponse<Response>().setHeader('Connection', 'close');
      throw new PayloadTooLargeException(`요청 전체 크기가 한도(${mb(maxTotalBytes)}MB)를 넘습니다.`);
    }
    return next.handle().pipe(
      catchError((e) => throwError(() => translateMulterError(e, this.config))),
      finalize(() => {
        for (const file of uploadedFiles(req)) {
          if (file.path) rm(file.path, { force: true }).catch((err) => this.logger.warn(`tmp cleanup ${file.path}: ${err.message}`));
        }
      }),
    );
  }
}

/** Runs after multer: enforces the total size and that every part really is a PDF. */
@Injectable()
export class UploadedTotalInterceptor implements NestInterceptor {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    const { maxTotalBytes } = this.config.get('upload', { infer: true });
    const files = uploadedFiles(req);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > maxTotalBytes) throw new PayloadTooLargeException(`업로드한 파일의 합계가 한도(${mb(maxTotalBytes)}MB)를 넘습니다.`);
    for (const f of files) await assertPdfFile(f);
    return next.handle();
  }
}

/** `@PdfUpload('file')` for one file, `@PdfUpload('files', true)` for many. */
export function PdfUpload(field: string, multiple = false) {
  return applyDecorators(
    UseInterceptors(UploadLimitsInterceptor, multiple ? FilesInterceptor(field) : FileInterceptor(field), UploadedTotalInterceptor),
  );
}

function uploadedFiles(req: Request): Express.Multer.File[] {
  const files = req.files;
  const list = Array.isArray(files) ? files : files ? Object.values(files).flat() : [];
  return req.file ? [req.file, ...list] : list;
}

function translateMulterError(e: unknown, config: ConfigService<AppConfig, true>): unknown {
  if (!(e instanceof HttpException) || e.getStatus() !== 413) return e;
  const msg = String((e.getResponse() as { message?: string }).message ?? e.message);
  const { maxFiles } = config.get('upload', { infer: true });
  const { maxUploadBytes } = config.get('storage', { infer: true });
  if (/too many files/i.test(msg)) return new PayloadTooLargeException(`파일은 한 번에 ${maxFiles}개까지 올릴 수 있습니다.`);
  if (/file too large/i.test(msg)) return new PayloadTooLargeException(`파일 하나의 크기는 ${mb(maxUploadBytes)}MB를 넘을 수 없습니다.`);
  return e;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Throws 400 unless `file` exists and starts like a PDF (works for disk and memory storage). */
export async function assertPdfFile(file: Express.Multer.File | undefined): Promise<void> {
  if (!file) throw new BadRequestException('"file" 필드로 PDF를 업로드하세요.');
  if (!isPdf(await readHead(file))) throw new BadRequestException(`${decodeFilename(file.originalname)}은(는) PDF 파일이 아닙니다.`);
}

async function readHead(file: Express.Multer.File): Promise<Uint8Array> {
  if (file.buffer) return file.buffer.subarray(0, 1024);
  const handle = await open(file.path, 'r');
  try {
    const head = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Throws the 400 used when a route expected a file and got none. */
export function requireFile(file: Express.Multer.File | undefined): asserts file is Express.Multer.File {
  if (!file) throw new BadRequestException('"file" 필드로 PDF를 업로드하세요.');
}

/** Multer decodes multipart filenames as latin1; browsers send UTF-8 (e.g. Korean names). */
export function decodeFilename(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/** RFC 5987 Content-Disposition that survives non-ASCII filenames. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
