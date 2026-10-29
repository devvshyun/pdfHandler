import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import { PdfExceptionFilter } from './common/pdf-exception.filter';
import { AppConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');
  app.enableCors();
  app.enableShutdownHooks();
  app.useBodyParser('json', { limit: `${Math.ceil(config.get('storage', { infer: true }).maxUploadBytes / 1024 / 1024) * 2}mb` });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new PdfExceptionFilter());

  if (config.get('db', { infer: true }).migrateOnBoot) {
    const executed = await app.get(MikroORM).getMigrator().up();
    if (executed.length) logger.log(`Applied migrations: ${executed.map((m) => m.name).join(', ')}`);
  }

  const frontend = config.get('frontendDist', { infer: true });
  if (frontend && existsSync(frontend)) {
    app.useStaticAssets(frontend);
    logger.log(`Serving frontend from ${frontend}`);
  }

  const port = config.get('port', { infer: true });
  await app.listen(port);
  logger.log(`pdfHandler API listening on http://localhost:${port}/api`);
}

void bootstrap();
