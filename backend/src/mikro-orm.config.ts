import 'dotenv/config';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/mysql';
import { loadConfig } from './config/configuration';
import { User } from './auth/user.entity';
import { DocumentVersion } from './documents/entities/document-version.entity';
import { PdfDocument } from './documents/entities/pdf-document.entity';
import { Migration20261029000000 } from './migrations/Migration20261029000000';
import { Migration20261029044818 } from './migrations/Migration20261029044818';

const { db } = loadConfig();

export default defineConfig({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  dbName: db.name,
  entities: [User, PdfDocument, DocumentVersion],
  extensions: [Migrator],
  migrations: {
    path: 'dist/migrations',
    pathTs: 'src/migrations',
    // Listed explicitly so the compiled app does not depend on file globbing.
    migrationsList: [
      { name: 'Migration20261029000000', class: Migration20261029000000 },
      { name: 'Migration20261029044818', class: Migration20261029044818 },
    ],
    transactional: true,
    // Fixed name: otherwise the snapshot file is named after DB_NAME.
    snapshotName: '.snapshot-pdfhandler',
  },
  debug: process.env.DB_DEBUG === 'true',
});
