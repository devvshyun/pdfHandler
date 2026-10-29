import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { PdfOperationError } from '@pdfhandler/core';
import { Response } from 'express';
import { LockTimeoutError } from '../redis/redis.service';

/** Maps domain errors coming from the PDF engine / lock to proper HTTP responses. */
@Catch(PdfOperationError, LockTimeoutError)
export class PdfExceptionFilter implements ExceptionFilter {
  catch(error: PdfOperationError | LockTimeoutError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = error instanceof LockTimeoutError ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
    res.status(status).json({ statusCode: status, error: error.name, message: error.message });
  }
}
