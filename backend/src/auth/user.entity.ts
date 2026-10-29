import { Entity, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'users' })
export class User {
  [OptionalProps]?: 'createdAt';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  /** Stored lower-cased and trimmed. */
  @Unique()
  @Property({ type: 'string', length: 254 })
  email!: string;

  /** `scrypt$N$r$p$<salt b64>$<hash b64>` (see password.ts). */
  @Property({ type: 'string', length: 255, hidden: true })
  passwordHash!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();
}
