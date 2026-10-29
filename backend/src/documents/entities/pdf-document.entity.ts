import { BigIntType, Collection, Entity, Index, ManyToOne, OneToMany, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { User } from '../../auth/user.entity';
import { DocumentVersion } from './document-version.entity';

@Entity({ tableName: 'documents' })
@Index({ properties: ['owner', 'updatedAt'] })
export class PdfDocument {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'currentVersion' | 'owner';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'string', length: 255 })
  title!: string;

  @Property({ type: 'string', length: 255 })
  originalName!: string;

  /**
   * Null for documents uploaded before accounts existed, or while AUTH_REQUIRED=false.
   * With AUTH_REQUIRED=true such rows are visible to nobody.
   */
  @ManyToOne(() => User, { nullable: true, deleteRule: 'set null' })
  owner?: User | null;

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
