import { EntityManager } from '@mikro-orm/mysql';
import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AppConfig } from '../config/configuration';
import { TokenService } from './token.service';
import { User } from './user.entity';

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  /** Which documents this request may touch; set by AuthGuard. */
  documentScope: DocumentScope;
}

/**
 * - `user`: AUTH_REQUIRED=true (default) — only documents owned by this user exist for the request.
 * - `single-tenant`: AUTH_REQUIRED=false — every document is visible, new ones have no owner
 *   (the pre-auth behaviour, meant for a local single-user install).
 */
export type DocumentScope = { kind: 'user'; userId: string } | { kind: 'single-tenant' };

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1];
}

/** Resolves the bearer token to a user (or null). Shared by AuthGuard and GET /auth/me. */
@Injectable()
export class AuthResolver {
  constructor(
    private readonly tokens: TokenService,
    private readonly em: EntityManager,
  ) {}

  async resolve(req: Request): Promise<AuthUser | null> {
    const token = bearerToken(req);
    if (!token) return null;
    const payload = this.tokens.verify(token);
    if (!payload) return null;
    // The account must still exist (a token outliving its user must not be able to create rows).
    const user = await this.em.fork().findOne(User, { id: payload.sub }, { fields: ['id', 'email'] });
    return user ? { id: user.id, email: user.email } : null;
  }
}

/** Guards /api/documents/**: 401 without a valid token when AUTH_REQUIRED, otherwise single-tenant. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly resolver: AuthResolver,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.config.get('auth', { infer: true }).required) {
      req.documentScope = { kind: 'single-tenant' };
      return true;
    }
    const user = await this.resolver.resolve(req);
    if (!user) throw new UnauthorizedException('로그인이 필요합니다.');
    req.user = user;
    req.documentScope = { kind: 'user', userId: user.id };
    return true;
  }
}

export const Scope = createParamDecorator((_data: unknown, ctx: ExecutionContext): DocumentScope => {
  const scope = ctx.switchToHttp().getRequest<AuthenticatedRequest>().documentScope;
  if (!scope) throw new Error('@Scope() used on a route without AuthGuard');
  return scope;
});
