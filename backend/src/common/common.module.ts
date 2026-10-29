import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { PdfWorkerPool } from '../pdf-worker/pdf-worker.pool';
import { PdfFontProvider } from './pdf-font.provider';
import { UploadedTotalInterceptor, UploadLimitsInterceptor } from './upload';

// Uploads go to disk (UPLOAD_TMP_DIR), not memory; see upload.ts for the limits and cleanup.
const multer = MulterModule.registerAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => {
    const upload = config.get('upload', { infer: true });
    return {
      storage: diskStorage({
        destination: upload.tmpDir,
        filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
      }),
      limits: {
        fileSize: config.get('storage', { infer: true }).maxUploadBytes,
        files: upload.maxFiles,
        fields: 20,
        // `operations` JSON may embed base64 images.
        fieldSize: 32 * 1024 * 1024,
      },
    };
  },
});

@Global()
@Module({
  imports: [multer],
  providers: [PdfFontProvider, PdfWorkerPool, UploadLimitsInterceptor, UploadedTotalInterceptor],
  exports: [PdfFontProvider, PdfWorkerPool, UploadLimitsInterceptor, UploadedTotalInterceptor, multer],
})
export class CommonModule {}
