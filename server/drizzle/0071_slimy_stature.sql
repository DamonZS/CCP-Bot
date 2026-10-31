/*
 * The vectors come back.
 *
 * `0010_drop_the_document_index.sql` dropped the `vector` extension along with the tables that
 * were the only thing using it. These tables are the use: a memory's own vector, and a knowledge
 * base of documents split into chunks. Nothing here is written by a platform — every vector is
 * computed from the text by the deployment's own embedding endpoint, and a row with no vector is
 * still a row: recall falls back to keywords rather than inventing one.
 *
 * THE EXTENSION NEEDS A PRIVILEGE, AND THIS MIGRATION FAILS WITHOUT IT. `CREATE EXTENSION` is
 * superuser-only unless the extension is trusted. The cluster CCP-Bot starts for itself is
 * `initdb`-ed by the same account that runs this, so it works there, and so does the development
 * container. On a managed PostgreSQL that refuses it, an administrator runs
 * `CREATE EXTENSION vector;` once in the deployment's database, and this migration then finds it
 * already there. It is not skipped silently: migrations here run as one transaction, so a
 * deployment that cannot create the extension does not come up half-migrated.
 *
 * THE WIDTH IS FIXED AT 1536, because a migration cannot read a variable: the declaration in
 * `MEMORY_EMBEDDING_DIM` is checked against this column at runtime, and a deployment that declares
 * something else stores no vectors and recalls by keyword, saying so once. Changing the width for
 * real is a new migration that drops and recreates these columns and indexes, then re-embeds what
 * is already stored — pgvector will not compare two vectors of different widths.
 */
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "embedding_digest" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_position_idx" ON "document_chunks" USING btree ("document_id","position");--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_owner_title_idx" ON "documents" USING btree ("owner_user_id","title");--> statement-breakpoint
CREATE INDEX "personal_memories_embedding_idx" ON "personal_memories" USING hnsw ("embedding" vector_cosine_ops);