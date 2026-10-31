import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { EMBEDDING_DIMENSIONS } from "../../memory/embedding/config";
import type { MemoryRecord, MemorySource } from "../../memory/types";
import { agents, users } from "./core";
import { jsonb } from "./json";

/**
 * `vector(1536)`, as pgvector writes it, read back as numbers — and NULL-safe in both directions.
 *
 * Not `vector()` from `drizzle-orm/pg-core`: its reader is `value.slice(1, -1)` with no null guard,
 * and that throw happens inside the driver's row mapper, where nothing catches it — so the query's
 * promise never settles and the caller waits forever instead of seeing an error. A NULL embedding is
 * the common case here rather than an edge: every memory written before this deployment had an
 * endpoint behind it holds one. The writer is guarded for the same reason — without it, clearing a
 * vector would send the four characters `null` and the server would refuse the row.
 */
const embeddingVector = customType<{
  data: number[] | null;
  driverData: string | null;
}>({
  dataType: () => `vector(${EMBEDDING_DIMENSIONS})`,
  toDriver: (value) => (value === null ? null : JSON.stringify(value)),
  fromDriver: (value) =>
    value === null
      ? null
      : value
          .slice(1, -1)
          .split(",")
          .map((part) => Number.parseFloat(part)),
});

export const memorySources = pgTable(
  "memory_sources",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolRef: text("tool_ref").notNull(),
    title: text("title").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    syncStatus: text("sync_status")
      .$type<MemorySource["syncStatus"]>()
      .notNull()
      .default("idle"),
    syncError: text("sync_error"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("memory_sources_owner_idx").on(table.ownerUserId),
    index("memory_sources_due_idx").on(table.enabled, table.nextSyncAt),
  ],
);
export const personalMemories = pgTable(
  "personal_memories",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => memorySources.id, {
      onDelete: "cascade",
    }),
    externalId: text("external_id"),
    importDigest: text("import_digest"),
    content: text("content").notNull(),
    provenance: text("provenance").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    reviewState: text("review_state")
      .$type<MemoryRecord["reviewState"]>()
      .notNull()
      .default("unreviewed"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * Who formed it: the person, a source import, or a Bot that observed it. A Bot-formed memory is
     * delivered only to the Bot that formed it, and only while that Bot still holds the app it
     * was read from (`source_ref`), so revoking the app withdraws the memory with it.
     */
    formedBy: text("formed_by")
      .$type<MemoryRecord["formedBy"]>()
      .notNull()
      .default("person"),
    formedByAgentId: text("formed_by_agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    sourceApp: text("source_app"),
    sourceRef: text("source_ref"),
    sourceLink: text("source_link"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    /**
     * The memory's id in CopilotKit Intelligence, when this deployment is entitled to Intelligence
     * memory and the memory has been mirrored there. Intelligence holds the content and does the
     * recall; this row keeps what Intelligence has no field for (provenance, review, who formed it,
     * which source and Bot may see it). Null while it is local only.
     */
    intelligenceMemoryId: text("intelligence_memory_id"),
    /** sha256 of the content last written to Intelligence, so an edit is mirrored exactly once. */
    intelligenceDigest: text("intelligence_digest"),
    /**
     * The memory's own vector, computed here from `content` — never fetched from a platform, and
     * never invented when the endpoint cannot answer. Null means "not embedded yet" (or "not
     * embedded any more", after an edit), which recall reads as "rank this one by keyword".
     *
     * The width is the whole reason the `vector` extension is back in the schema: `pgvector` will
     * not compare two vectors of different widths, so the declaration in `MEMORY_EMBEDDING_DIM` has
     * to match this column or the writer refuses to store anything. Changing it means a migration
     * that recreates the column and its index, then re-embedding what is already stored.
     */
    embedding: embeddingVector("embedding"),
    /** sha256 of the content this vector was computed from, so an edit is embedded exactly once. */
    embeddingDigest: text("embedding_digest"),
    /** Which model produced it: vectors from two models are not comparable, so recall checks this. */
    embeddingModel: text("embedding_model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("personal_memories_owner_idx").on(table.ownerUserId, table.enabled),
    index("personal_memories_intelligence_idx").on(
      table.ownerUserId,
      table.intelligenceMemoryId,
    ),
    index("personal_memories_formed_idx").on(
      table.ownerUserId,
      table.formedByAgentId,
    ),
    uniqueIndex("personal_memories_import_idx").on(
      table.sourceId,
      table.externalId,
    ),
    // One Bot-formed fact per person and content: two runs forming the same fact at once store it
    // once, which a read-then-insert cannot promise.
    uniqueIndex("personal_memories_formed_digest_idx")
      .on(table.ownerUserId, table.importDigest)
      .where(sql`${table.formedBy} = 'bot'`),
    /*
     * Cosine distance, because that is the comparison `store.retrieve` scores with
     * (`1 - (embedding <=> query)`), and because the vectors are not length-normalised by every
     * endpoint that can answer. Rows with no vector are simply not in the index; they are still
     * recalled by keyword.
     */
    index("personal_memories_embedding_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

/**
 * A document a person put into their own knowledge base.
 *
 * The content itself is never rewritten here: importing the same document again replaces its
 * chunks, and the digest is what says whether anything changed. `source` records where it came
 * from, so a person can tell two documents with the same title apart.
 */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    source: text("source").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_owner_idx").on(table.ownerUserId, table.updatedAt),
    /*
     * A person imports a document by name: importing the same title again replaces what that
     * document holds rather than making a second one, which is what lets a re-import be a plain
     * "I updated this file" instead of a pile of near-duplicates to search through.
     */
    uniqueIndex("documents_owner_title_idx").on(
      table.ownerUserId,
      table.title,
    ),
  ],
);

/**
 * One chunk of one document, with the vector it was embedded as.
 *
 * A chunk is the unit of retrieval: the answer to a search is a chunk and the document it came
 * from, because a whole document is too large to hand a model and too coarse to be an answer.
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** The heading this chunk sat under, when the document has one. Shown with a search hit. */
    heading: text("heading"),
    content: text("content").notNull(),
    /**
     * Null for the same reason a memory's is: the chunk exists and can be found by keyword even
     * when nothing could embed it. See `personalMemories.embedding`.
     */
    embedding: embeddingVector("embedding"),
    embeddingModel: text("embedding_model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("document_chunks_position_idx").on(
      table.documentId,
      table.position,
    ),
    index("document_chunks_embedding_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);
