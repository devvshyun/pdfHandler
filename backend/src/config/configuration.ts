import { resolve } from 'node:path';

export interface AppConfig {
  port: number;
  db: { host: string; port: number; user: string; password: string; name: string; migrateOnBoot: boolean };
  redis: { url: string; cacheTtlSeconds: number };
  storage: { dir: string; maxUploadBytes: number };
  pdfFontPath?: string;
  frontendDist?: string;
}

const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    db: {
      host: env.DB_HOST ?? '127.0.0.1',
      port: Number(env.DB_PORT ?? 3306),
      user: env.DB_USER ?? 'pdfhandler',
      password: env.DB_PASSWORD ?? 'pdfhandler',
      name: env.DB_NAME ?? 'pdfhandler',
      migrateOnBoot: bool(env.DB_MIGRATE_ON_BOOT, true),
    },
    redis: {
      url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 300),
    },
    storage: {
      dir: resolve(env.STORAGE_DIR ?? './storage'),
      maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 100) * 1024 * 1024,
    },
    pdfFontPath: env.PDF_FONT_PATH || undefined,
    frontendDist: env.FRONTEND_DIST ? resolve(env.FRONTEND_DIST) : undefined,
  };
}
