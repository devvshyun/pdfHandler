import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AppConfig } from '../config/configuration';
import { PdfFontProvider } from './pdf-font.provider';

const multer = MulterModule.registerAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => ({
    storage: memoryStorage(),
    limits: { fileSize: config.get('storage', { infer: true }).maxUploadBytes, files: 50 },
  }),
});

@Global()
@Module({
  imports: [multer],
  providers: [PdfFontProvider],
  exports: [PdfFontProvider, multer],
})
export class CommonModule {}
