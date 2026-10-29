import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AppConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';

export type RateLimitBucket = 'auth' | 'tools' | 'documents';
const RATE_LIMIT_KEY = 'pdfhandler:rateLimit';

/** Applies the named rule from config (`RATE_LIMIT_<BUCKET>`) to a controller or handler. */
export const RateLimit = (bucket: RateLimitBucket) => SetMetadata(RATE_LIMIT_KEY, bucket);

export class TooManyRequestsException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: `요청이 너무 많습니다. ${retryAfterSeconds}초 후 다시 시도하세요.`,
        retryAfter: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Fixed-window rate limit backed by Redis counters, shared by every API instance.
 * Keyed by user when the request is authenticated (put it after AuthGuard), otherwise by client IP
 * (set TRUST_PROXY behind a reverse proxy). If Redis is down requests are let through.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.getAllAndOverride<RateLimitBucket | undefined>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!bucket) return true;
    const rule = this.config.get('rateLimit', { infer: true })[bucket];
    if (!rule || rule.limit <= 0) return true;

    const req = context.switchToHttp().getRequest<Request & Partial<AuthenticatedRequest>>();
    const res = context.switchToHttp().getResponse<Response>();
    const identity = req.user ? `u:${req.user.id}` : `ip:${clientIp(req)}`;
    const hit = await this.redis.hit(`rl:${bucket}:${identity}`, rule.windowSeconds);
    if (!hit) return true;

    res.setHeader('X-RateLimit-Limit', String(rule.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rule.limit - hit.count)));
    res.setHeader('X-RateLimit-Reset', String(hit.resetSeconds));
    if (hit.count > rule.limit) {
      res.setHeader('Retry-After', String(hit.resetSeconds));
      throw new TooManyRequestsException(hit.resetSeconds);
    }
    return true;
  }
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
