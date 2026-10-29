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
  app.set('trust proxy', config.get('trustProxy', { infer: true }));
  // No CORS headers unless CORS_ORIGINS lists origins: the bundled frontend is same-origin and
  // `vite dev` proxies /api, so cross-origin access is opt-in.
  const origins = config.get('corsOrigins', { infer: true });
  if (origins.length) {
    app.enableCors({
      origin: origins.includes('*') ? true : origins,
      methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['Content-Disposition', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
      maxAge: 600,
    });
    logger.log(`CORS enabled for: ${origins.join(', ')}`);
  }
  if (!config.get('auth', { infer: true }).required) {
    logger.warn('AUTH_REQUIRED=false: single-tenant mode, every visitor can read and delete every document.');
  }
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
