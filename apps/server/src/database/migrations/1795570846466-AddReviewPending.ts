import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReviewPending1795570846466 implements MigrationInterface {
  name = 'AddReviewPending1795570846466';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "review_pending" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "collectionId" integer NOT NULL,
                "mediaServerId" varchar NOT NULL,
                "title" varchar NOT NULL,
                "year" integer,
                "arrService" varchar NOT NULL,
                "arrSettingsId" integer NOT NULL,
                "arrId" integer NOT NULL,
                "providerId" integer NOT NULL,
                "path" varchar NOT NULL,
                "addedAt" varchar NOT NULL,
                "sizeBytes" bigint NOT NULL,
                "plexIds" text NOT NULL,
                "libraryId" varchar NOT NULL,
                "plexCollectionId" varchar NOT NULL,
                "approvedAt" datetime NOT NULL,
                "deleteAt" datetime NOT NULL,
                "status" varchar NOT NULL DEFAULT ('pending'),
                "resolvedAt" datetime,
                "note" varchar,
                "seerr" varchar,
                "verifiedAt" datetime
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_review_pending_collection_media" ON "review_pending" ("collectionId", "mediaServerId")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_review_pending_status_delete_at" ON "review_pending" ("status", "deleteAt")
        `);
    await queryRunner.query(`
            DROP INDEX "idx_review_pending_collection_media"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_review_pending_status_delete_at"
        `);
    await queryRunner.query(`
            CREATE TABLE "temporary_review_pending" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "collectionId" integer NOT NULL,
                "mediaServerId" varchar NOT NULL,
                "title" varchar NOT NULL,
                "year" integer,
                "arrService" varchar NOT NULL,
                "arrSettingsId" integer NOT NULL,
                "arrId" integer NOT NULL,
                "providerId" integer NOT NULL,
                "path" varchar NOT NULL,
                "addedAt" varchar NOT NULL,
                "sizeBytes" bigint NOT NULL,
                "plexIds" text NOT NULL,
                "libraryId" varchar NOT NULL,
                "plexCollectionId" varchar NOT NULL,
                "approvedAt" datetime NOT NULL,
                "deleteAt" datetime NOT NULL,
                "status" varchar NOT NULL DEFAULT ('pending'),
                "resolvedAt" datetime,
                "note" varchar,
                "seerr" varchar,
                "verifiedAt" datetime,
                CONSTRAINT "FK_bcd3491cf2f301ad0d1b77a815a" FOREIGN KEY ("collectionId") REFERENCES "collection" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            INSERT INTO "temporary_review_pending"(
                    "id",
                    "collectionId",
                    "mediaServerId",
                    "title",
                    "year",
                    "arrService",
                    "arrSettingsId",
                    "arrId",
                    "providerId",
                    "path",
                    "addedAt",
                    "sizeBytes",
                    "plexIds",
                    "libraryId",
                    "plexCollectionId",
                    "approvedAt",
                    "deleteAt",
                    "status",
                    "resolvedAt",
                    "note",
                    "seerr",
                    "verifiedAt"
                )
            SELECT "id",
                "collectionId",
                "mediaServerId",
                "title",
                "year",
                "arrService",
                "arrSettingsId",
                "arrId",
                "providerId",
                "path",
                "addedAt",
                "sizeBytes",
                "plexIds",
                "libraryId",
                "plexCollectionId",
                "approvedAt",
                "deleteAt",
                "status",
                "resolvedAt",
                "note",
                "seerr",
                "verifiedAt"
            FROM "review_pending"
        `);
    await queryRunner.query(`
            DROP TABLE "review_pending"
        `);
    await queryRunner.query(`
            ALTER TABLE "temporary_review_pending"
                RENAME TO "review_pending"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_review_pending_collection_media" ON "review_pending" ("collectionId", "mediaServerId")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_review_pending_status_delete_at" ON "review_pending" ("status", "deleteAt")
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "idx_review_pending_status_delete_at"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_review_pending_collection_media"
        `);
    await queryRunner.query(`
            ALTER TABLE "review_pending"
                RENAME TO "temporary_review_pending"
        `);
    await queryRunner.query(`
            CREATE TABLE "review_pending" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "collectionId" integer NOT NULL,
                "mediaServerId" varchar NOT NULL,
                "title" varchar NOT NULL,
                "year" integer,
                "arrService" varchar NOT NULL,
                "arrSettingsId" integer NOT NULL,
                "arrId" integer NOT NULL,
                "providerId" integer NOT NULL,
                "path" varchar NOT NULL,
                "addedAt" varchar NOT NULL,
                "sizeBytes" bigint NOT NULL,
                "plexIds" text NOT NULL,
                "libraryId" varchar NOT NULL,
                "plexCollectionId" varchar NOT NULL,
                "approvedAt" datetime NOT NULL,
                "deleteAt" datetime NOT NULL,
                "status" varchar NOT NULL DEFAULT ('pending'),
                "resolvedAt" datetime,
                "note" varchar,
                "seerr" varchar,
                "verifiedAt" datetime
            )
        `);
    await queryRunner.query(`
            INSERT INTO "review_pending"(
                    "id",
                    "collectionId",
                    "mediaServerId",
                    "title",
                    "year",
                    "arrService",
                    "arrSettingsId",
                    "arrId",
                    "providerId",
                    "path",
                    "addedAt",
                    "sizeBytes",
                    "plexIds",
                    "libraryId",
                    "plexCollectionId",
                    "approvedAt",
                    "deleteAt",
                    "status",
                    "resolvedAt",
                    "note",
                    "seerr",
                    "verifiedAt"
                )
            SELECT "id",
                "collectionId",
                "mediaServerId",
                "title",
                "year",
                "arrService",
                "arrSettingsId",
                "arrId",
                "providerId",
                "path",
                "addedAt",
                "sizeBytes",
                "plexIds",
                "libraryId",
                "plexCollectionId",
                "approvedAt",
                "deleteAt",
                "status",
                "resolvedAt",
                "note",
                "seerr",
                "verifiedAt"
            FROM "temporary_review_pending"
        `);
    await queryRunner.query(`
            DROP TABLE "temporary_review_pending"
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_review_pending_status_delete_at" ON "review_pending" ("status", "deleteAt")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_review_pending_collection_media" ON "review_pending" ("collectionId", "mediaServerId")
        `);
    await queryRunner.query(`
            DROP INDEX "idx_review_pending_status_delete_at"
        `);
    await queryRunner.query(`
            DROP INDEX "idx_review_pending_collection_media"
        `);
    await queryRunner.query(`
            DROP TABLE "review_pending"
        `);
  }
}
