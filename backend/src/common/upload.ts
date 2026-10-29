import { BadRequestException } from '@nestjs/common';
import { isPdf } from '@pdfhandler/core';

export function assertPdfUpload(file: Express.Multer.File | undefined): asserts file is Express.Multer.File {
  if (!file) throw new BadRequestException('"file" 필드로 PDF를 업로드하세요.');
  if (!isPdf(file.buffer)) throw new BadRequestException(`${file.originalname}은(는) PDF 파일이 아닙니다.`);
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
