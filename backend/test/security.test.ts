import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { TokenService } from '../src/auth/token.service';
import { parseOperations, validateOperations } from '../src/common/operation-validation';
import { AppConfig, loadConfig } from '../src/config/configuration';

const configFor = (env: NodeJS.ProcessEnv) => {
  const cfg = loadConfig(env);
  return { get: (key: keyof AppConfig) => cfg[key] } as unknown as ConfigService<AppConfig, true>;
};

describe('password hashing', () => {
  it('uses a per-user salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong horse', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('TokenService', () => {
  const tokens = new TokenService(configFor({ JWT_SECRET: 'test-secret-test-secret-test-secret' }));

  it('round-trips and rejects tampering, other secrets and expiry', () => {
    const { token } = tokens.sign('user-1', 'a@example.com', 1000);
    expect(tokens.verify(token, 1001)).toMatchObject({ sub: 'user-1', email: 'a@example.com' });
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'user-2', email: 'x', iat: 1000, exp: 99999999999 })).toString('base64url');
    expect(tokens.verify(`${h}.${forged}.${s}`, 1001)).toBeNull();
    expect(tokens.verify(`${h}.${p}.`, 1001)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(tokens.verify(`${none}.${p}.`, 1001)).toBeNull();
    expect(new TokenService(configFor({ JWT_SECRET: 'another-secret' })).verify(token, 1001)).toBeNull();
    expect(tokens.verify(token, 1000 + tokens.ttlSeconds)).toBeNull();
  });

  it('refuses to start in production without JWT_SECRET, warns in development', () => {
    expect(() => new TokenService(configFor({ NODE_ENV: 'production' }))).toThrow(/JWT_SECRET/);
    expect(() => new TokenService(configFor({}))).not.toThrow();
  });
});

describe('config', () => {
  it('parses auth, CORS, rate limits and worker settings', () => {
    const cfg = loadConfig({
      AUTH_REQUIRED: 'false',
      CORS_ORIGINS: 'https://a.example, https://b.example/',
      RATE_LIMIT_TOOLS: '5/10',
      RATE_LIMIT_AUTH: '7',
      PDF_WORKERS: '0',
      MAX_UPLOAD_MB: '10',
    });
    expect(cfg.auth.required).toBe(false);
    expect(cfg.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(cfg.rateLimit.tools).toEqual({ limit: 5, windowSeconds: 10 });
    expect(cfg.rateLimit.auth).toEqual({ limit: 7, windowSeconds: 60 });
    expect(cfg.workers.size).toBe(0);
    expect(cfg.upload.maxTotalBytes).toBe(20 * 1024 * 1024);
    expect(cfg.upload.maxFiles).toBe(20);
  });

  it('defaults to auth on and no CORS', () => {
    const cfg = loadConfig({});
    expect(cfg.auth.required).toBe(true);
    expect(cfg.corsOrigins).toEqual([]);
  });
});

describe('operation validation', () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bad = (ops: unknown) => {
    try {
      validateOperations(ops);
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).message;
    }
    throw new Error('expected a validation error');
  };

  it('accepts well-formed operations', () => {
    const ops = [
      { type: 'rotate', pages: [0, 1], degrees: 90 },
      { type: 'watermark', text: 'X', color: { r: 1, g: 0, b: 0 } },
      { type: 'addImage', page: 0, x: 0, y: 0, width: 10, height: 10, imageBase64: `data:image/png;base64,${PNG_1PX}` },
      { type: 'redact', page: 0, areas: [{ x: 1, y: 1, width: 5, height: 5 }], fill: null },
      { type: 'metadata', title: 't', keywords: ['a'] },
    ];
    expect(validateOperations(ops)).toHaveLength(5);
  });

  it('rejects malformed payloads with the failing path', () => {
    expect(bad([])).toMatch(/비어 있지 않은 배열/);
    expect(bad([{ type: 'explode' }])).toMatch(/operations\[0\]\.type/);
    expect(bad([{ type: 'rotate', pages: ['1'], degrees: 90 }])).toMatch(/operations\[0\]\.pages\[0\]/);
    expect(bad([{ type: 'rotate', pages: [0], degrees: 45 }])).toMatch(/degrees/);
    expect(bad([{ type: 'addImage', page: 0, x: 0, y: 0, width: 10, height: 10, imageBase64: '###' }])).toMatch(/base64/);
    expect(bad([{ type: 'addImage', page: 0, x: 0, y: 0, width: 10, height: 10, imageBase64: Buffer.from('GIF89a-not-allowed-here-padding-padding').toString('base64') }])).toMatch(/PNG 또는 JPEG/);
    expect(bad([{ type: 'addText', page: 0, x: 'a', y: 0, text: 'hi' }])).toMatch(/operations\[0\]\.x/);
    expect(bad([{ type: 'redact', page: 0, areas: [{ x: 0, y: 0, width: -1, height: 1 }] }])).toMatch(/areas\[0\]\.width/);
    expect(bad([{ type: 'watermark', text: 'x', color: { r: 2, g: 0, b: 0 } }])).toMatch(/color\.r/);
    expect(() => parseOperations('not json')).toThrow(BadRequestException);
  });
});
