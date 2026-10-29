import { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PdfOperation } from '@pdfhandler/core';
import { DocumentScope } from '../auth/auth.guard';
import { User } from '../auth/user.entity';
import { AppConfig } from '../config/configuration';
import { PdfWorkerPool } from '../pdf-worker/pdf-worker.pool';
import { RedisService } from '../redis/redis.service';
import { StorageService } from '../storage/storage.service';
import { ListDocumentsQuery } from './dto/documents.dto';
import { DocumentVersion, VersionSource } from './entities/document-version.entity';
import { PdfDocument } from './entities/pdf-document.entity';

export interface VersionView {
  version: number;
  source: VersionSource;
  size: number;
  pageCount: number;
  sha256: string;
  note?: string;
  operations?: unknown[];
  createdAt: Date;
}

export interface DocumentView {
  id: string;
  title: string;
  originalName: string;
  currentVersion: number;
  pageCount: number;
  size: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDetailView extends DocumentView {
  versions: VersionView[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/** A new version's bytes, already described (page count, hash) by a worker. */
interface ProducedVersion {
  /** Writes the file under `key` in storage. */
  write: (key: string) => Promise<void>;
  size: number;
  pageCount: number;
  sha256: string;
  note?: string;
  operations?: unknown[];
}

/**
 * Cache keys are namespaced by scope (`u:<userId>` or `all` for AUTH_REQUIRED=false), so a cached
 * list or detail can never be served to another user. Invalidation clears both namespaces a
 * document can appear in: its owner's and the single-tenant one.
 */
const scopeKey = (scope: DocumentScope) => (scope.kind === 'user' ? `u:${scope.userId}` : 'all');
const listGen = (key: string) => `documents:${key}`;
const detailKey = (key: string, id: string) => `doc:${key}:${id}`;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly lockTtlMs: number;

  constructor(
    private readonly em: EntityManager,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly pool: PdfWorkerPool,
    config: ConfigService<AppConfig, true>,
  ) {
    // The per-document lock must outlive the slowest PDF task it may wrap.
    this.lockTtlMs = config.get('workers', { infer: true }).taskTimeoutMs + 30_000;
  }

  async create(scope: DocumentScope, upload: { path: string }, originalName: string, title?: string): Promise<DocumentDetailView> {
    const { info, sha256, size } = await this.pool.run({ kind: 'info', input: { path: upload.path } });
    const doc = this.em.create(PdfDocument, {
      title: title?.trim() || info.title?.trim() || originalName.replace(/\.pdf$/i, ''),
      originalName,
      pageCount: info.pageCount,
      size,
      owner: scope.kind === 'user' ? this.em.getReference(User, scope.userId) : null,
    });
    const storageKey = versionKey(doc.id, 1);
    await this.storage.putFile(storageKey, upload.path);
    this.em.create(DocumentVersion, {
      document: doc,
      version: 1,
      source: VersionSource.UPLOAD,
      storageKey,
      size,
      pageCount: info.pageCount,
      sha256,
    });
    try {
      await this.em.flush();
    } catch (e) {
      await this.storage.removePrefix(doc.id);
      throw e;
    }
    await this.invalidate(doc);
    return this.get(scope, doc.id);
  }

  async list(scope: DocumentScope, query: ListDocumentsQuery): Promise<Page<DocumentView>> {
    const { page, limit, q } = query;
    const sk = scopeKey(scope);
    const gen = await this.redis.generation(listGen(sk));
    const cacheKey = `docs:list:${sk}:${gen}:${page}:${limit}:${q ?? ''}`;
    const cached = await this.redis.getJson<Page<DocumentView>>(cacheKey);
    if (cached) return cached;

    const where = { ...scopeWhere(scope), ...(q ? { title: { $like: `%${q.replace(/[%_\\]/g, '\\$&')}%` } } : {}) };
    const [items, total] = await this.em.findAndCount(PdfDocument, where, {
      orderBy: { updatedAt: 'desc' },
      limit,
      offset: (page - 1) * limit,
    });
    const result = { items: items.map(toView), total, page, limit };
    await this.redis.setJson(cacheKey, result);
    return result;
  }

  async get(scope: DocumentScope, id: string): Promise<DocumentDetailView> {
    const key = detailKey(scopeKey(scope), id);
    const cached = await this.redis.getJson<DocumentDetailView>(key);
    if (cached) return cached;
    const doc = await this.findDoc(scope, id);
    const versions = await this.em.find(DocumentVersion, { document: doc }, { orderBy: { version: 'desc' } });
    const view: DocumentDetailView = { ...toView(doc), versions: versions.map(toVersionView) };
    await this.redis.setJson(key, view);
    return view;
  }

  async rename(scope: DocumentScope, id: string, title: string): Promise<DocumentDetailView> {
    const doc = await this.findDoc(scope, id);
    doc.title = title.trim() || doc.title;
    await this.em.flush();
    await this.invalidate(doc);
    return this.get(scope, id);
  }

  async getVersion(scope: DocumentScope, id: string, version?: number): Promise<{ doc: PdfDocument; version: DocumentVersion }> {
    const doc = await this.findDoc(scope, id);
    const v = await this.em.findOne(DocumentVersion, { document: doc, version: version ?? doc.currentVersion });
    if (!v) throw new NotFoundException(`버전 ${version}을(를) 찾을 수 없습니다.`);
    return { doc, version: v };
  }

  async openFile(scope: DocumentScope, id: string, version?: number) {
    const { doc, version: v } = await this.getVersion(scope, id, version);
    const { stream, size } = await this.storage.stream(v.storageKey);
    const base = doc.title.replace(/[\\/:*?"<>|]/g, '_');
    const filename = v.version === doc.currentVersion ? `${base}.pdf` : `${base} (v${v.version}).pdf`;
    return { stream, size, filename };
  }

  /** Stores a new version uploaded by the browser editor. */
  addClientVersion(scope: DocumentScope, id: string, upload: { path: string }, note?: string): Promise<DocumentDetailView> {
    return this.addVersion(scope, id, VersionSource.CLIENT_EDIT, async () => {
      const { info, sha256, size } = await this.pool.run({ kind: 'info', input: { path: upload.path } });
      return { write: (key) => this.storage.putFile(key, upload.path), size, pageCount: info.pageCount, sha256, note };
    });
  }

  /** Applies `operations` (already validated) to the current version in a worker and stores the result. */
  applyOperations(scope: DocumentScope, id: string, operations: PdfOperation[], note?: string): Promise<DocumentDetailView> {
    return this.addVersion(scope, id, VersionSource.SERVER_OPERATIONS, async (current) => {
      const out = await this.pool.run({ kind: 'apply', input: { path: this.storage.localPath(current.storageKey) }, operations });
      return {
        write: (key) => this.storage.put(key, out.bytes),
        size: out.bytes.byteLength,
        pageCount: out.pageCount,
        sha256: out.sha256,
        note,
        operations: operations.map(redactLargeFields),
      };
    });
  }

  /** Makes an old version current again by copying it as a new version (history is never rewritten). */
  revert(scope: DocumentScope, id: string, version: number): Promise<DocumentDetailView> {
    return this.addVersion(scope, id, VersionSource.SERVER_OPERATIONS, async (_current, doc, em) => {
      const target = await em.findOne(DocumentVersion, { document: doc, version });
      if (!target) throw new NotFoundException(`버전 ${version}을(를) 찾을 수 없습니다.`);
      return {
        write: (key) => this.storage.putFile(key, this.storage.localPath(target.storageKey)),
        size: Number(target.size),
        pageCount: target.pageCount,
        sha256: target.sha256,
        note: `v${version}(으)로 되돌림`,
      };
    });
  }

  /**
   * Permanently deletes one old version (row + stored file), e.g. one that still contains text
   * that was redacted later. Numbering is kept: later versions are not renumbered.
   */
  async deleteVersion(scope: DocumentScope, id: string, version: number): Promise<DocumentDetailView> {
    await this.findDoc(scope, id);
    await this.redis.withLock(`doc:${id}`, async () => {
      const em = this.em.fork();
      const doc = await em.findOneOrFail(PdfDocument, { id, ...scopeWhere(scope) }, { failHandler: notFound });
      if (version === doc.currentVersion) throw new BadRequestException('현재 버전은 삭제할 수 없습니다. 다른 버전을 먼저 복원하세요.');
      const v = await em.findOne(DocumentVersion, { document: doc, version });
      if (!v) throw new NotFoundException(`버전 ${version}을(를) 찾을 수 없습니다.`);
      await em.remove(v).flush();
      await this.removeFiles([v.storageKey]);
    });
    return this.afterVersionChange(scope, id);
  }

  /** Deletes every version except the current one. */
  async purgeVersions(scope: DocumentScope, id: string): Promise<DocumentDetailView & { deleted: number }> {
    await this.findDoc(scope, id);
    let deleted = 0;
    await this.redis.withLock(`doc:${id}`, async () => {
      const em = this.em.fork();
      const doc = await em.findOneOrFail(PdfDocument, { id, ...scopeWhere(scope) }, { failHandler: notFound });
      const old = await em.find(DocumentVersion, { document: doc, version: { $ne: doc.currentVersion } });
      if (!old.length) return;
      old.forEach((v) => em.remove(v));
      await em.flush();
      deleted = old.length;
      await this.removeFiles(old.map((v) => v.storageKey));
    });
    return { ...(await this.afterVersionChange(scope, id)), deleted };
  }

  async remove(scope: DocumentScope, id: string): Promise<void> {
    const doc = await this.findDoc(scope, id);
    await this.em.removeAndFlush(doc);
    await this.storage.removePrefix(id);
    await this.invalidate(doc);
  }

  // -------------------------------------------------------------------------

  private async addVersion(
    scope: DocumentScope,
    id: string,
    source: VersionSource,
    produce: (current: DocumentVersion, doc: PdfDocument, em: EntityManager) => Promise<ProducedVersion>,
  ): Promise<DocumentDetailView> {
    // Ownership is checked before taking the lock, so other users cannot even contend for it.
    await this.findDoc(scope, id);
    // The lock serialises version numbering per document across all API instances;
    // the (document, version) unique key is the backstop if Redis is unavailable.
    await this.redis.withLock(
      `doc:${id}`,
      async () => {
        const em = this.em.fork();
        const doc = await em.findOneOrFail(PdfDocument, { id, ...scopeWhere(scope) }, { failHandler: notFound });
        const current = await em.findOneOrFail(DocumentVersion, { document: doc, version: doc.currentVersion });
        const produced = await produce(current, doc, em);
        const next = doc.currentVersion + 1;
        const storageKey = versionKey(id, next);
        await produced.write(storageKey);
        em.create(DocumentVersion, {
          document: doc,
          version: next,
          source,
          storageKey,
          size: produced.size,
          pageCount: produced.pageCount,
          sha256: produced.sha256,
          note: produced.note,
          operations: produced.operations,
        });
        doc.currentVersion = next;
        doc.pageCount = produced.pageCount;
        doc.size = produced.size;
        try {
          await em.flush();
        } catch (e) {
          await this.storage.remove(storageKey).catch(() => undefined);
          throw e;
        }
      },
      this.lockTtlMs,
    );
    return this.afterVersionChange(scope, id);
  }

  private async afterVersionChange(scope: DocumentScope, id: string): Promise<DocumentDetailView> {
    // The request-scoped identity map may still hold the pre-update document.
    this.em.clear();
    const doc = await this.findDoc(scope, id);
    await this.invalidate(doc);
    return this.get(scope, id);
  }

  private async removeFiles(keys: string[]): Promise<void> {
    for (const key of keys) {
      // The row is already gone; a leftover file is unreachable through the API but is logged
      // because the point of deleting a version is usually privacy.
      await this.storage.remove(key).catch((e) => this.logger.error(`could not delete stored version ${key}: ${e.message}`));
    }
  }

  private async findDoc(scope: DocumentScope, id: string): Promise<PdfDocument> {
    // Someone else's id and a missing id look the same (404), so ids cannot be probed.
    const doc = await this.em.findOne(PdfDocument, { id, ...scopeWhere(scope) });
    if (!doc) throw notFound();
    return doc;
  }

  private async invalidate(doc: PdfDocument): Promise<void> {
    const keys = ['all', ...(doc.owner ? [`u:${doc.owner.id}`] : [])];
    await this.redis.del(...keys.map((k) => detailKey(k, doc.id)));
    for (const k of keys) await this.redis.bumpGeneration(listGen(k));
  }
}

function scopeWhere(scope: DocumentScope): { owner?: string } {
  // Legacy rows (owner_id NULL) never match a user scope.
  return scope.kind === 'user' ? { owner: scope.userId } : {};
}

function notFound(): NotFoundException {
  return new NotFoundException('문서를 찾을 수 없습니다.');
}

function versionKey(id: string, version: number): string {
  return `${id}/v${version}.pdf`;
}

function toView(d: PdfDocument): DocumentView {
  return {
    id: d.id,
    title: d.title,
    originalName: d.originalName,
    currentVersion: d.currentVersion,
    pageCount: d.pageCount,
    size: Number(d.size),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toVersionView(v: DocumentVersion): VersionView {
  return {
    version: v.version,
    source: v.source,
    size: Number(v.size),
    pageCount: v.pageCount,
    sha256: v.sha256,
    note: v.note ?? undefined,
    // MariaDB stores JSON as LONGTEXT, so the driver may hand back a string.
    operations: typeof v.operations === 'string' ? JSON.parse(v.operations) : (v.operations ?? undefined),
    createdAt: v.createdAt,
  };
}

/** Image payloads can be megabytes; keep the history row small. */
function redactLargeFields(op: PdfOperation): unknown {
  if (op.type === 'addImage') return { ...op, imageBase64: `<${op.imageBase64.length} chars>` };
  if (op.type === 'replaceText' && op.fallbackImage) {
    return { ...op, fallbackImage: { ...op.fallbackImage, imageBase64: `<${op.fallbackImage.imageBase64.length} chars>` } };
  }
  return op;
}
