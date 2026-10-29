import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { AppConfig } from '../config/configuration';
import { RateLimit, RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { AuthResolver } from './auth.guard';
import { AuthService } from './auth.service';

export class CredentialsBody {
  @IsEmail({}, { message: '올바른 이메일 주소를 입력하세요.' }) @MaxLength(254)
  email!: string;

  @IsString() @MinLength(8, { message: '비밀번호는 8자 이상이어야 합니다.' }) @MaxLength(200)
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly resolver: AuthResolver,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  register(@Body() body: CredentialsBody) {
    return this.auth.register(body.email, body.password);
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  login(@Body() body: CredentialsBody) {
    return this.auth.login(body.email, body.password);
  }

  /**
   * Always 200 so the UI can tell "not logged in" from "server down":
   * `{ authRequired, user: null }` when the token is missing, invalid or expired.
   */
  @Get('me')
  async me(@Req() req: Request) {
    const authRequired = this.config.get('auth', { infer: true }).required;
    return { authRequired, user: await this.resolver.resolve(req) };
  }
}
