import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/configuration';

export interface TokenPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

export const DEV_JWT_SECRET = 'pdfhandler-dev-insecure-secret-do-not-use-in-production';
const b64url = (data: string) => Buffer.from(data, 'utf8').toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

/**
 * Minimal HS256 JWT on node:crypto. Only tokens with exactly our header are accepted, so
 * `alg: none` / algorithm-confusion tricks are impossible by construction.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly secret: Buffer;
  readonly ttlSeconds: number;

  constructor(config: ConfigService<AppConfig, true>) {
    const auth = config.get('auth', { infer: true });
    const production = config.get('production', { infer: true });
    this.ttlSeconds = auth.tokenTtlSeconds;
    let secret = auth.jwtSecret;
    if (!secret) {
      if (production) throw new Error('JWT_SECRET must be set when NODE_ENV=production (e.g. `openssl rand -hex 32`).');
      secret = DEV_JWT_SECRET;
      this.logger.warn('*******************************************************************');
      this.logger.warn('* JWT_SECRET is not set: using a built-in DEVELOPMENT secret.      *');
      this.logger.warn('* Anyone can forge login tokens. Set JWT_SECRET before exposing it. *');
      this.logger.warn('*******************************************************************');
    } else if (secret.length < 32 && production) {
      this.logger.warn('JWT_SECRET is shorter than 32 characters; use a long random value.');
    }
    this.secret = Buffer.from(secret, 'utf8');
  }

  sign(sub: string, email: string, now = Math.floor(Date.now() / 1000)): { token: string; expiresAt: Date } {
    const payload: TokenPayload = { sub, email, iat: now, exp: now + this.ttlSeconds };
    const body = `${HEADER}.${b64url(JSON.stringify(payload))}`;
    return { token: `${body}.${this.mac(body)}`, expiresAt: new Date(payload.exp * 1000) };
  }

  /** Returns the payload, or null for anything malformed, forged or expired. */
  verify(token: string, now = Math.floor(Date.now() / 1000)): TokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== HEADER) return null;
    const expected = Buffer.from(this.mac(`${parts[0]}.${parts[1]}`));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenPayload;
      if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || payload.exp <= now) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private mac(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}
