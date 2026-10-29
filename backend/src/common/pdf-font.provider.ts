import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { AppConfig } from '../config/configuration';

/** Loads the optional TTF/OTF configured by PDF_FONT_PATH once at boot. */
@Injectable()
export class PdfFontProvider implements OnModuleInit {
  private readonly logger = new Logger(PdfFontProvider.name);
  font?: Uint8Array;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async onModuleInit(): Promise<void> {
    const path = this.config.get('pdfFontPath', { infer: true });
    if (!path) return;
    try {
      this.font = new Uint8Array(await readFile(path));
      this.logger.log(`Loaded PDF font ${path}`);
    } catch (e) {
      this.logger.warn(`Could not load PDF_FONT_PATH=${path}: ${(e as Error).message}`);
    }
  }
}
