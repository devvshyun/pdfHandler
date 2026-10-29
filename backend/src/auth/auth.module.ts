import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard, AuthResolver } from './auth.guard';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { User } from './user.entity';

@Global()
@Module({
  imports: [MikroOrmModule.forFeature([User])],
  controllers: [AuthController],
  providers: [AuthService, TokenService, AuthResolver, AuthGuard],
  exports: [TokenService, AuthResolver, AuthGuard],
})
export class AuthModule {}
