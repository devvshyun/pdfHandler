import { Migration } from '@mikro-orm/migrations';

/**
 * Accounts + document ownership. Existing documents keep owner_id = NULL: with AUTH_REQUIRED=true
 * they are visible to nobody (assign them manually with an UPDATE if needed).
 */
export class Migration20261029044818 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table \`users\` (\`id\` varchar(36) not null, \`email\` varchar(254) not null, \`password_hash\` varchar(255) not null, \`created_at\` datetime not null, primary key (\`id\`)) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`users\` add unique \`users_email_unique\`(\`email\`);`);

    this.addSql(`alter table \`documents\` add \`owner_id\` varchar(36) null;`);
    this.addSql(`alter table \`documents\` add constraint \`documents_owner_id_foreign\` foreign key (\`owner_id\`) references \`users\` (\`id\`) on update cascade on delete set null;`);
    this.addSql(`alter table \`documents\` add index \`documents_owner_id_index\`(\`owner_id\`);`);
    this.addSql(`alter table \`documents\` add index \`documents_owner_id_updated_at_index\`(\`owner_id\`, \`updated_at\`);`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table \`documents\` drop foreign key \`documents_owner_id_foreign\`;`);

    this.addSql(`drop table if exists \`users\`;`);

    this.addSql(`alter table \`documents\` drop index \`documents_owner_id_index\`;`);
    this.addSql(`alter table \`documents\` drop index \`documents_owner_id_updated_at_index\`;`);
    this.addSql(`alter table \`documents\` drop column \`owner_id\`;`);
  }

}
