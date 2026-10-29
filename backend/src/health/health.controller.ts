import { MikroORM } from '@mikro-orm/core';
import { Controller, Get } from '@nestjs/common';
import { PdfWorkerPool } from '../pdf-worker/pdf-worker.pool';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly redis: RedisService,
    private readonly pool: PdfWorkerPool,
  ) {}

  @Get()
  async check() {
    const [db, redis] = await Promise.all([this.orm.isConnected(), this.redis.ping()]);
    return { status: db ? 'ok' : 'degraded', db, redis, workers: this.pool.stats };
  }
}
