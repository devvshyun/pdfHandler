import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/mysql';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { TooManyRequestsException } from '../rate-limit/rate-limit.guard';
import { RedisService } from '../redis/redis.service';
import { dummyHash, hashPassword, verifyPassword } from './password';
import { TokenService } from './token.service';
import { User } from './user.entity';

export interface AuthResult {
  token: string;
  expiresAt: Date;
  user: { id: string; email: string };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

@Injectable()
export class AuthService {
  constructor(
    private readonly em: EntityManager,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const normalized = normalizeEmail(email);
    const em = this.em.fork();
    if (await em.count(User, { email: normalized })) throw new ConflictException('이미 가입된 이메일입니다.');
    const user = em.create(User, { email: normalized, passwordHash: await hashPassword(password) });
    try {
      await em.flush();
    } catch (e) {
      if (e instanceof UniqueConstraintViolationException) throw new ConflictException('이미 가입된 이메일입니다.');
      throw e;
    }
    return this.issue(user);
  }

  /**
   * Besides the per-IP limit on /auth/*, failed logins are counted per e-mail address so one
   * account cannot be brute-forced from many IPs. Success does not reset the window on purpose.
   */
  async login(email: string, password: string): Promise<AuthResult> {
    const normalized = normalizeEmail(email);
    const rule = this.config.get('rateLimit', { infer: true }).login;
    const failKey = `rl:login-fail:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
    if (rule.limit > 0) {
      const failures = await this.redis.count(failKey);
      if (failures.count >= rule.limit) throw new TooManyRequestsException(failures.resetSeconds || rule.windowSeconds);
    }
    const user = await this.em.fork().findOne(User, { email: normalized });
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !ok) {
      if (rule.limit > 0) await this.redis.hit(failKey, rule.windowSeconds);
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    return this.issue(user);
  }

  private issue(user: User): AuthResult {
    const { token, expiresAt } = this.tokens.sign(user.id, user.email);
    return { token, expiresAt, user: { id: user.id, email: user.email } };
  }
}
