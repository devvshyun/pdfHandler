// Boots the compiled API (dist/main.js) as a child process against a real MySQL + Redis.
import { ChildProcess, execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const BACKEND = resolve(__dirname, '../..');

export const DB = {
  host: process.env.E2E_DB_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.E2E_DB_PORT ?? process.env.DB_PORT ?? 3306),
  user: process.env.E2E_DB_USER ?? process.env.DB_USER ?? 'pdfhandler',
  password: process.env.E2E_DB_PASSWORD ?? process.env.DB_PASSWORD ?? 'pdfhandler',
  name: process.env.E2E_DB_NAME ?? 'pdfhandler_test',
};
export const REDIS_URL = process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Null when MySQL is reachable and the test DB was reset; otherwise the reason to skip. */
export async function prepareDatabase(): Promise<string | null> {
  try {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB.name, connectTimeout: 3000 });
    try {
      // The suite owns this database: start from an empty schema so every migration runs.
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of ['document_versions', 'documents', 'users', 'mikro_orm_migrations']) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      await conn.end();
    }
  } catch (e) {
    return `MySQL ${DB.user}@${DB.host}:${DB.port}/${DB.name} unreachable (${(e as Error).message}). Set E2E_DB_* to run the API e2e tests.`;
  }
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2000 });
    await redis.connect();
    await redis.ping();
    redis.disconnect();
  } catch (e) {
    return `Redis ${REDIS_URL} unreachable (${(e as Error).message}). Set E2E_REDIS_URL to run the API e2e tests.`;
  }
  return null;
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** The e2e suite runs the compiled server (worker threads need dist/); rebuild when stale. */
export function ensureBuilt(): void {
  const main = join(BACKEND, 'dist/main.js');
  let built = 0;
  try {
    built = statSync(main).mtimeMs;
  } catch {
    /* not built */
  }
  if (built < newestMtime(join(BACKEND, 'src'))) execSync('npx nest build', { cwd: BACKEND, stdio: 'inherit' });
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

export interface TestServer {
  base: string;
  storageDir: string;
  uploadsDir: string;
  log: () => string;
  stop: () => Promise<void>;
}

export async function startServer(env: Record<string, string>): Promise<TestServer> {
  const port = await freePort();
  const storage = mkdtempSync(join(tmpdir(), 'pdfh-e2e-store-'));
  const uploads = mkdtempSync(join(tmpdir(), 'pdfh-e2e-up-'));
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: BACKEND,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_HOST: DB.host,
      DB_PORT: String(DB.port),
      DB_USER: DB.user,
      DB_PASSWORD: DB.password,
      DB_NAME: DB.name,
      REDIS_URL,
      // Fresh counters/caches per server, without touching anybody else's keys.
      REDIS_KEY_PREFIX: `e2e:${randomBytes(4).toString('hex')}:`,
      STORAGE_DIR: storage,
      UPLOAD_TMP_DIR: uploads,
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    base,
    log: () => output,
    storageDir: storage,
    uploadsDir: uploads,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
      rmSync(storage, { recursive: true, force: true });
      rmSync(uploads, { recursive: true, force: true });
    },
  };
}
