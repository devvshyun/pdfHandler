import { Migration } from '@mikro-orm/migrations';

export class Migration20261029000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql("create table `documents` (`id` varchar(36) not null, `title` varchar(255) not null, `original_name` varchar(255) not null, `current_version` int not null default 1, `page_count` int not null, `size` bigint not null, `created_at` datetime not null, `updated_at` datetime not null, primary key (`id`)) default character set utf8mb4 engine = InnoDB");
    this.addSql("alter table `documents` add index `documents_updated_at_index`(`updated_at`)");
    this.addSql("create table `document_versions` (`id` int unsigned not null auto_increment primary key, `document_id` varchar(36) not null, `version` int not null, `source` enum('upload', 'client_edit', 'server_operations') not null, `storage_key` varchar(512) not null, `size` bigint not null, `page_count` int not null, `sha256` varchar(64) not null, `note` varchar(500) null, `operations` json null, `created_at` datetime not null) default character set utf8mb4 engine = InnoDB");
    this.addSql("alter table `document_versions` add index `document_versions_document_id_index`(`document_id`)");
    this.addSql("alter table `document_versions` add unique `document_versions_document_id_version_unique`(`document_id`, `version`)");
    this.addSql("alter table `document_versions` add constraint `document_versions_document_id_foreign` foreign key (`document_id`) references `documents` (`id`) on update cascade on delete cascade");
  }

  override async down(): Promise<void> {
    this.addSql("drop table if exists `document_versions`");
    this.addSql("drop table if exists `documents`");
  }
}
