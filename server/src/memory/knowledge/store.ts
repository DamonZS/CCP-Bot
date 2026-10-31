import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { documentChunks, documents } from "../../db/schema/memory";
import type { Embedder } from "../embedding/provider";
import { chunkText } from "./chunk";

/**
 * The deployment's own knowledge base: documents a person imported, split into chunks, each with
 * a vector when an embedding endpoint answers.
 *
 * It is not the platform's knowledge connector. Those connectors ask the vendor at the moment of
 * the question and store nothing; this stores the text here and searches it here, so a search
 * works with no network at all and every hit is a passage someone can open. Recall is the same
 * shape as memory recall: keyword matches score `LEXICAL_WEIGHT`, a chunk the vectors put nearby
 * adds `VECTOR_WEIGHT` times its cosine similarity, and a chunk that is both ranks above a chunk
 * that is only one. With no embedding endpoint the keyword half is the whole answer rather than
 * an error.
 */
const LEXICAL_WEIGHT = 0.5;
const VECTOR_WEIGHT = 0.5;
const NEARBY_LIMIT = 20;
const LEXICAL_LIMIT = 200;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 100_000;

export class KnowledgeRefusedError extends Error {}

export type KnowledgeHit = {
  documentId: string;
  title: string;
  position: number;
  heading: string | null;
  content: string;
  /**
   * `0.5 * lexical + 0.5 * cosine`, where `lexical` is 1 for a keyword match and `cosine` is the
   * similarity of the chunk's vector to the query's. It ranks hits against each other; it is not
   * a threshold and nothing is filtered by it.
   */
  score: number;
};

export type ImportedDocument = {
  documentId: string;
  title: string;
  chunks: number;
  embedded: number;
};

export type KnowledgeStore = {
  import(ownerUserId: string, input: unknown): Promise<ImportedDocument>;
  search(
    ownerUserId: string,
    query: string,
    limit?: number,
  ): Promise<KnowledgeHit[]>;
};

export function createKnowledgeStore(
  database: Database,
  options: { embedder?: Embedder } = {},
): KnowledgeStore {
  const { embedder } = options;
  const digestOf = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  return {
    /**
     * Importing a title that already exists replaces what that document holds, chunks included:
     * the second import of a file is an update, not a second copy to search through.
     */
    async import(ownerUserId: string, input: unknown): Promise<ImportedDocument> {
      const { title, text, source } = parseDocument(input);
      const chunks = chunkText(text);
      const vectors = embedder
        ? await embedder.embed(chunks.map((chunk) => chunk.content))
        : undefined;
      const digest = digestOf(text);
      const saved = await database.transaction(async (tx) => {
        const [row] = await tx
          .insert(documents)
          .values({
            id: randomUUID(),
            ownerUserId,
            title,
            source,
            contentDigest: digest,
          })
          .onConflictDoUpdate({
            target: [documents.ownerUserId, documents.title],
            set: { source, contentDigest: digest, updatedAt: new Date() },
          })
          .returning({ id: documents.id });
        if (!row) throw new Error("Document insert returned no row.");
        await tx
          .delete(documentChunks)
          .where(eq(documentChunks.documentId, row.id));
        await tx.insert(documentChunks).values(
          chunks.map((chunk, index) => ({
            id: randomUUID(),
            documentId: row.id,
            position: chunk.position,
            heading: chunk.heading,
            content: chunk.content,
            embedding: vectors?.[index] ?? null,
            embeddingModel: vectors?.[index] ? (embedder?.model ?? null) : null,
          })),
        );
        return row.id;
      });
      return {
        documentId: saved,
        title,
        chunks: chunks.length,
        embedded: vectors?.length ?? 0,
      };
    },
    /**
     * Keyword matches and vector neighbours, scored together. Ownership is part of the read: one
     * person's documents never answer another person's search.
     */
    async search(
      ownerUserId: string,
      query: string,
      limit = DEFAULT_LIMIT,
    ): Promise<KnowledgeHit[]> {
      const term = query.trim();
      if (term.length === 0) return [];
      const active = embedder;
      const lexical = await database
        .select({ chunk: documentChunks, title: documents.title })
        .from(documentChunks)
        .innerJoin(documents, eq(documents.id, documentChunks.documentId))
        .where(
          and(
            eq(documents.ownerUserId, ownerUserId),
            sql`strpos(lower(${documentChunks.content}), lower(${term})) > 0`,
          ),
        )
        .limit(LEXICAL_LIMIT);
      const scored = new Map<
        string,
        { chunk: typeof documentChunks.$inferSelect; title: string; score: number }
      >();
      for (const row of lexical)
        scored.set(row.chunk.id, {
          chunk: row.chunk,
          title: row.title,
          score: LEXICAL_WEIGHT,
        });
      const vector = active ? (await active.embed([term]))?.[0] : undefined;
      if (active && vector) {
        const distance = sql<number>`${documentChunks.embedding} <=> ${JSON.stringify(vector)}::vector`;
        const nearby = await database
          .select({
            chunk: documentChunks,
            title: documents.title,
            distance,
          })
          .from(documentChunks)
          .innerJoin(documents, eq(documents.id, documentChunks.documentId))
          .where(
            and(
              eq(documents.ownerUserId, ownerUserId),
              isNotNull(documentChunks.embedding),
              eq(documentChunks.embeddingModel, active.model),
            ),
          )
          .orderBy(distance)
          .limit(NEARBY_LIMIT);
        for (const row of nearby) {
          const similarity = similarityOf(row.distance);
          /* Cosine zero is orthogonal — nothing shared with the query — so it adds nothing. */
          if (similarity <= 0) continue;
          const found = scored.get(row.chunk.id);
          if (found) found.score += VECTOR_WEIGHT * similarity;
          else
            scored.set(row.chunk.id, {
              chunk: row.chunk,
              title: row.title,
              score: VECTOR_WEIGHT * similarity,
            });
        }
      }
      return [...scored.values()]
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.chunk.createdAt.getTime() - left.chunk.createdAt.getTime(),
        )
        .slice(0, clampLimit(limit))
        .map(({ chunk, title, score }) => ({
          documentId: chunk.documentId,
          title,
          position: chunk.position,
          heading: chunk.heading,
          content: chunk.content,
          score,
        }));
    },
  };
}

function parseDocument(input: unknown): {
  title: string;
  text: string;
  source: string;
} {
  if (!input || typeof input !== "object")
    throw new KnowledgeRefusedError("Supply a document as JSON.");
  const record = input as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const source =
    typeof record.source === "string" && record.source.trim().length > 0
      ? record.source.trim()
      : "import";
  if (title.length === 0)
    throw new KnowledgeRefusedError("A document needs a title.");
  if (title.length > MAX_TITLE_CHARS)
    throw new KnowledgeRefusedError(
      `A document title is at most ${MAX_TITLE_CHARS} characters.`,
    );
  if (text.length === 0)
    throw new KnowledgeRefusedError("A document needs text to import.");
  if (text.length > MAX_TEXT_CHARS)
    throw new KnowledgeRefusedError(
      `A document is at most ${MAX_TEXT_CHARS} characters; import it in parts.`,
    );
  return { title, text, source };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/** pgvector's cosine distance, as a score in `[0, 1]` where 1 is the same vector. */
function similarityOf(distance: unknown): number {
  const value = 1 - Number(distance);
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}