import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/configuration';

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

const HIT_SCRIPT = `
local c = redis.call('incr', KEYS[1])
if c == 1 then redis.call('expire', KEYS[1], ARGV[1]) end
local t = redis.call('ttl', KEYS[1])
if t < 0 then redis.call('expire', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;

/**
 * Thin wrapper around ioredis providing a JSON cache and a simple distributed lock.
 * Cache calls never throw: if Redis is down the app keeps working straight from MySQL.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  readonly defaultTtl: number;

  constructor(config: ConfigService<AppConfig, true>) {
    const redis = config.get('redis', { infer: true });
    this.defaultTtl = redis.cacheTtlSeconds;
    this.client = new Redis(redis.url, { maxRetriesPerRequest: 1, lazyConnect: false, keyPrefix: redis.keyPrefix || undefined });
    this.client.on('error', (e) => this.logger.warn(`Redis error: ${e.message}`));
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (e) {
      this.logger.warn(`cache get ${key} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds = this.defaultTtl): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      this.logger.warn(`cache set ${key} failed: ${(e as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (e) {
      this.logger.warn(`cache del failed: ${(e as Error).message}`);
    }
  }

  /** Monotonic counter used to invalidate a whole family of cache keys at once. */
  async generation(name: string): Promise<string> {
    try {
      return (await this.client.get(`gen:${name}`)) ?? '0';
    } catch {
      return 'offline';
    }
  }

  async bumpGeneration(name: string): Promise<void> {
    try {
      await this.client.incr(`gen:${name}`);
    } catch (e) {
      this.logger.warn(`generation bump ${name} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Runs `fn` while holding `lock:<key>`. Waits up to `waitMs` for the lock.
   * If Redis is unreachable the function still runs; callers must keep a DB-level guard
   * (e.g. a unique constraint) as the last line of defence.
   */
  async withLock<T>(key: string, fn: () => Promise<T>, ttlMs = 30_000, waitMs = 10_000): Promise<T> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    let acquired = false;
    try {
      while (!acquired) {
        acquired = (await this.client.set(lockKey, token, 'PX', ttlMs, 'NX')) === 'OK';
        if (!acquired) {
          if (Date.now() > deadline) throw new LockTimeoutError(key);
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } catch (e) {
      if (e instanceof LockTimeoutError) throw e;
      this.logger.warn(`lock ${key} unavailable, continuing without it: ${(e as Error).message}`);
    }
    try {
      return await fn();
    } finally {
      if (acquired) {
        await this.client.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token).catch(() => undefined);
      }
    }
  }

  /**
   * Fixed-window counter: increments `key` and returns the new count and seconds until the window
   * resets. Returns null when Redis is unavailable (callers fail open).
   */
  async hit(key: string, windowSeconds: number): Promise<{ count: number; resetSeconds: number } | null> {
    try {
      const [count, ttl] = (await this.client.eval(HIT_SCRIPT, 1, key, windowSeconds)) as [number, number];
      return { count, resetSeconds: ttl > 0 ? ttl : windowSeconds };
    } catch (e) {
      this.logger.warn(`rate counter ${key} unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  /** Current value of a counter written by `hit` (0 when absent or Redis is down). */
  async count(key: string): Promise<{ count: number; resetSeconds: number }> {
    try {
      const [raw, ttl] = await Promise.all([this.client.get(key), this.client.ttl(key)]);
      return { count: Number(raw ?? 0), resetSeconds: Math.max(ttl, 0) };
    } catch {
      return { count: 0, resetSeconds: 0 };
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Timed out waiting for lock "${key}"`);
    this.name = 'LockTimeoutError';
  }
}
