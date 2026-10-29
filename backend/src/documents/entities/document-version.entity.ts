import { BigIntType, Entity, Enum, ManyToOne, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { PdfDocument } from './pdf-document.entity';

export enum VersionSource {
  UPLOAD = 'upload',
  CLIENT_EDIT = 'client_edit',
  SERVER_OPERATIONS = 'server_operations',
}

@Entity({ tableName: 'document_versions' })
@Unique({ properties: ['document', 'version'] })
export class DocumentVersion {
  [OptionalProps]?: 'createdAt' | 'note' | 'operations';

  @PrimaryKey({ type: 'integer', autoincrement: true })
  id!: number;

  @ManyToOne(() => PdfDocument, { deleteRule: 'cascade' })
  document!: PdfDocument;

  @Property({ type: 'integer' })
  version!: number;

  @Enum({ items: () => VersionSource })
  source!: VersionSource;

  @Property({ type: 'string', length: 512 })
  storageKey!: string;

  @Property({ type: new BigIntType('number') })
  size!: number;

  @Property({ type: 'integer' })
  pageCount!: number;

  @Property({ type: 'string', length: 64 })
  sha256!: string;

  @Property({ type: 'string', length: 500, nullable: true })
  note?: string;

  /** The operation list that produced this version (server-side edits only). */
  @Property({ type: 'json', nullable: true })
  operations?: unknown[];

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();
}
