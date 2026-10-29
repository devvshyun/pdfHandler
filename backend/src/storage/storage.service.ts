import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, ReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AppConfig } from '../config/configuration';

/** Local-disk object storage. Keys look like `<documentId>/v<version>.pdf`. */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.root = config.get('storage', { infer: true }).dir;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('파일이 저장소에 없습니다.');
      throw e;
    }
  }

  async stream(key: string): Promise<{ stream: ReadStream; size: number }> {
    const path = this.pathFor(key);
    try {
      const { size } = await stat(path);
      return { stream: createReadStream(path), size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('파일이 저장소에 없습니다.');
      throw e;
    }
  }

  async removePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return path;
  }
}
