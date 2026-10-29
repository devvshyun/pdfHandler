import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { loadConfig } from './config/configuration';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health/health.controller';
import ormConfig from './mikro-orm.config';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { ToolsModule } from './tools/tools.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [() => loadConfig()] }),
    MikroOrmModule.forRoot(ormConfig),
    CommonModule,
    RedisModule,
    AuthModule,
    StorageModule,
    DocumentsModule,
    ToolsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
