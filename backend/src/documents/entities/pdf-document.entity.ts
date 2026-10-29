import { BigIntType, Collection, Entity, Index, OneToMany, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { DocumentVersion } from './document-version.entity';

@Entity({ tableName: 'documents' })
export class PdfDocument {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'currentVersion';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'string', length: 255 })
  title!: string;

  @Property({ type: 'string', length: 255 })
  originalName!: string;

  @Property({ type: 'integer' })
  currentVersion: number = 1;

  @Property({ type: 'integer' })
  pageCount!: number;

  @Property({ type: new BigIntType('number') })
  size!: number;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Index()
  @Property({ type: 'datetime', onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  @OneToMany(() => DocumentVersion, (v) => v.document, { orphanRemoval: true })
  versions = new Collection<DocumentVersion>(this);
}
