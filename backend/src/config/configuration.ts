import { tmpdir } from 'node:os';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

export interface RateLimitRule {
  /** Requests allowed per window. 0 disables the rule. */
  limit: number;
  windowSeconds: number;
}

export interface AppConfig {
  port: number;
  production: boolean;
  /** Express `trust proxy` setting, so rate limits see the client IP behind a reverse proxy. */
  trustProxy: string | number | boolean;
  db: { host: string; port: number; user: string; password: string; name: string; migrateOnBoot: boolean };
  redis: { url: string; cacheTtlSeconds: number; keyPrefix: string };
  storage: { dir: string; maxUploadBytes: number };
  upload: { tmpDir: string; maxFiles: number; maxTotalBytes: number };
  auth: { required: boolean; jwtSecret?: string; tokenTtlSeconds: number };
  /** Allowed CORS origins. Empty = no CORS headers at all (same-origin only). `['*']` = any origin. */
  corsOrigins: string[];
  rateLimit: { auth: RateLimitRule; login: RateLimitRule; tools: RateLimitRule; documents: RateLimitRule };
  workers: { size: number; queueMax: number; taskTimeoutMs: number };
  pdfFontPath?: string;
  frontendDist?: string;
}

const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1');
const num = (v: string | undefined, fallback: number) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

/** `RATE_LIMIT_TOOLS=30/60` = 30 requests per 60 seconds. */
function rule(v: string | undefined, fallback: RateLimitRule): RateLimitRule {
  if (!v) return fallback;
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+)\s*)?$/.exec(v);
  if (!m) return fallback;
  return { limit: Number(m[1]), windowSeconds: m[2] ? Math.max(1, Number(m[2])) : fallback.windowSeconds };
}

function trustProxy(v: string | undefined): string | number | boolean {
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const maxUploadBytes = num(env.MAX_UPLOAD_MB, 100) * 1024 * 1024;
  return {
    port: num(env.PORT, 3000),
    production: env.NODE_ENV === 'production',
    trustProxy: trustProxy(env.TRUST_PROXY),
    db: {
      host: env.DB_HOST ?? '127.0.0.1',
      port: num(env.DB_PORT, 3306),
      user: env.DB_USER ?? 'pdfhandler',
      password: env.DB_PASSWORD ?? 'pdfhandler',
      name: env.DB_NAME ?? 'pdfhandler',
      migrateOnBoot: bool(env.DB_MIGRATE_ON_BOOT, true),
    },
    redis: {
      url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      cacheTtlSeconds: num(env.CACHE_TTL_SECONDS, 300),
      keyPrefix: env.REDIS_KEY_PREFIX ?? '',
    },
    storage: {
      dir: resolve(env.STORAGE_DIR ?? './storage'),
      maxUploadBytes,
    },
    upload: {
      tmpDir: resolve(env.UPLOAD_TMP_DIR || join(tmpdir(), 'pdfhandler-uploads')),
      maxFiles: num(env.MAX_MERGE_FILES, 20),
      // Whole multipart request (all files together); defaults to 2x the per-file limit.
      maxTotalBytes: num(env.MAX_REQUEST_MB, (maxUploadBytes / 1024 / 1024) * 2) * 1024 * 1024,
    },
    auth: {
      required: bool(env.AUTH_REQUIRED, true),
      jwtSecret: env.JWT_SECRET || undefined,
      tokenTtlSeconds: num(env.JWT_TTL_SECONDS, 12 * 60 * 60),
    },
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    rateLimit: {
      auth: rule(env.RATE_LIMIT_AUTH, { limit: 20, windowSeconds: 60 }),
      login: rule(env.RATE_LIMIT_LOGIN, { limit: 10, windowSeconds: 900 }),
      tools: rule(env.RATE_LIMIT_TOOLS, { limit: 30, windowSeconds: 60 }),
      documents: rule(env.RATE_LIMIT_DOCUMENTS, { limit: 300, windowSeconds: 60 }),
    },
    workers: {
      size: num(env.PDF_WORKERS, Math.max(1, Math.min(4, availableParallelism() - 1))),
      queueMax: num(env.PDF_QUEUE_MAX, 16),
      taskTimeoutMs: num(env.PDF_TASK_TIMEOUT_MS, 120_000),
    },
    pdfFontPath: env.PDF_FONT_PATH || undefined,
    frontendDist: env.FRONTEND_DIST ? resolve(env.FRONTEND_DIST) : undefined,
  };
}
