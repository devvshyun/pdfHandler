import { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { applyOperations, getPdfInfo, OPERATION_TYPES, PdfOperation } from '@pdfhandler/core';
import { createHash } from 'node:crypto';
import { PdfFontProvider } from '../common/pdf-font.provider';
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

const LIST_GEN = 'documents';
const detailKey = (id: string) => `doc:${id}`;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly em: EntityManager,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly fonts: PdfFontProvider,
  ) {}

  async create(data: Uint8Array, originalName: string, title?: string): Promise<DocumentDetailView> {
    const info = await getPdfInfo(data);
    const doc = this.em.create(PdfDocument, {
      title: title?.trim() || info.title?.trim() || originalName.replace(/\.pdf$/i, ''),
      originalName,
      pageCount: info.pageCount,
      size: data.byteLength,
    });
    const storageKey = versionKey(doc.id, 1);
    await this.storage.put(storageKey, data);
    this.em.create(DocumentVersion, {
      document: doc,
      version: 1,
      source: VersionSource.UPLOAD,
      storageKey,
      size: data.byteLength,
      pageCount: info.pageCount,
      sha256: sha256(data),
    });
    try {
      await this.em.flush();
    } catch (e) {
      await this.storage.removePrefix(doc.id);
      throw e;
    }
    await this.redis.bumpGeneration(LIST_GEN);
    return this.get(doc.id);
  }

  async list(query: ListDocumentsQuery): Promise<Page<DocumentView>> {
    const { page, limit, q } = query;
    const gen = await this.redis.generation(LIST_GEN);
    const cacheKey = `docs:list:${gen}:${page}:${limit}:${q ?? ''}`;
    const cached = await this.redis.getJson<Page<DocumentView>>(cacheKey);
    if (cached) return cached;

    const where = q ? { title: { $like: `%${q.replace(/[%_\\]/g, '\\$&')}%` } } : {};
    const [items, total] = await this.em.findAndCount(PdfDocument, where, {
      orderBy: { updatedAt: 'desc' },
      limit,
      offset: (page - 1) * limit,
    });
    const result = { items: items.map(toView), total, page, limit };
    await this.redis.setJson(cacheKey, result);
    return result;
  }

  async get(id: string): Promise<DocumentDetailView> {
    const cached = await this.redis.getJson<DocumentDetailView>(detailKey(id));
    if (cached) return cached;
    const doc = await this.findDoc(id);
    const versions = await this.em.find(DocumentVersion, { document: doc }, { orderBy: { version: 'desc' } });
    const view: DocumentDetailView = { ...toView(doc), versions: versions.map(toVersionView) };
    await this.redis.setJson(detailKey(id), view);
    return view;
  }

  async rename(id: string, title: string): Promise<DocumentDetailView> {
    const doc = await this.findDoc(id);
    doc.title = title.trim() || doc.title;
    await this.em.flush();
    await this.invalidate(id);
    return this.get(id);
  }

  async getVersion(id: string, version?: number): Promise<{ doc: PdfDocument; version: DocumentVersion }> {
    const doc = await this.findDoc(id);
    const v = await this.em.findOne(DocumentVersion, { document: doc, version: version ?? doc.currentVersion });
    if (!v) throw new NotFoundException(`버전 ${version}을(를) 찾을 수 없습니다.`);
    return { doc, version: v };
  }

  async openFile(id: string, version?: number) {
    const { doc, version: v } = await this.getVersion(id, version);
    const { stream, size } = await this.storage.stream(v.storageKey);
    const base = doc.title.replace(/[\\/:*?"<>|]/g, '_');
    const filename = v.version === doc.currentVersion ? `${base}.pdf` : `${base} (v${v.version}).pdf`;
    return { stream, size, filename };
  }

  /** Stores a new version uploaded by the browser editor. */
  addClientVersion(id: string, data: Uint8Array, note?: string): Promise<DocumentDetailView> {
    return this.addVersion(id, VersionSource.CLIENT_EDIT, async () => ({ data, note }));
  }

  /** Applies `operations` to the current version on the server and stores the result. */
  applyOperations(id: string, operations: PdfOperation[], note?: string): Promise<DocumentDetailView> {
    for (const op of operations) {
      if (!OPERATION_TYPES.includes(op?.type)) throw new BadRequestException(`알 수 없는 작업 type: ${String(op?.type)}`);
    }
    return this.addVersion(id, VersionSource.SERVER_OPERATIONS, async (current) => {
      const source = await this.storage.read(current.storageKey);
      const data = await applyOperations(source, operations, { font: this.fonts.font });
      return { data, note, operations: operations.map(redactLargeFields) };
    });
  }

  /** Makes an old version current again by copying it as a new version (history is never rewritten). */
  revert(id: string, version: number): Promise<DocumentDetailView> {
    return this.addVersion(id, VersionSource.SERVER_OPERATIONS, async (_current, doc) => {
      const { version: target } = await this.getVersion(doc.id, version);
      return { data: await this.storage.read(target.storageKey), note: `v${version}(으)로 되돌림` };
    });
  }

  async remove(id: string): Promise<void> {
    const doc = await this.findDoc(id);
    await this.em.removeAndFlush(doc);
    await this.storage.removePrefix(id);
    await this.invalidate(id);
  }

  // -------------------------------------------------------------------------

  private async addVersion(
    id: string,
    source: VersionSource,
    produce: (
      current: DocumentVersion,
      doc: PdfDocument,
    ) => Promise<{ data: Uint8Array; note?: string; operations?: unknown[] }>,
  ): Promise<DocumentDetailView> {
    // The lock serialises version numbering per document across all API instances;
    // the (document, version) unique key is the backstop if Redis is unavailable.
    await this.redis.withLock(`doc:${id}`, async () => {
      const em = this.em.fork();
      const doc = await em.findOne(PdfDocument, { id });
      if (!doc) throw new NotFoundException('문서를 찾을 수 없습니다.');
      const current = await em.findOneOrFail(DocumentVersion, { document: doc, version: doc.currentVersion });
      const { data, note, operations } = await produce(current, doc);
      const info = await getPdfInfo(data);
      const next = doc.currentVersion + 1;
      const storageKey = versionKey(id, next);
      await this.storage.put(storageKey, data);
      em.create(DocumentVersion, {
        document: doc,
        version: next,
        source,
        storageKey,
        size: data.byteLength,
        pageCount: info.pageCount,
        sha256: sha256(data),
        note,
        operations,
      });
      doc.currentVersion = next;
      doc.pageCount = info.pageCount;
      doc.size = data.byteLength;
      await em.flush();
    });
    // The request-scoped identity map may still hold the pre-update document (e.g. after revert).
    this.em.clear();
    await this.invalidate(id);
    return this.get(id);
  }

  private async findDoc(id: string): Promise<PdfDocument> {
    const doc = await this.em.findOne(PdfDocument, { id });
    if (!doc) throw new NotFoundException('문서를 찾을 수 없습니다.');
    return doc;
  }

  private async invalidate(id: string): Promise<void> {
    await this.redis.del(detailKey(id));
    await this.redis.bumpGeneration(LIST_GEN);
  }
}

function versionKey(id: string, version: number): string {
  return `${id}/v${version}.pdf`;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
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
  return op;
}
