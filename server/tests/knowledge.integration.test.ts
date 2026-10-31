import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { documents } from "../src/db/schema/memory";
import { createMemoryStore, type MemoryStore } from "../src/memory/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  cosine,
  embeddingEnvironment,
  startEmbeddingEndpoint,
  type EmbeddingEndpoint,
  vectorOf,
} from "./support/embeddings";

/**
 * The knowledge base on a real database with a real endpoint: text is imported here, chunked here,
 * and searched here, with no vendor asked at question time.
 *
 * The query is `deploy pipeline`, and the two documents are built the same way as the memory
 * recall test: `exact` carries the phrase, so the keyword half finds it and its vector agrees with
 * the query (score 1); `mention` says "deploy" and then waters it down, so the phrase is absent and
 * only the vector half finds it (score about 0.11); `lunch` shares nothing, and its vector is
 * orthogonal to the query, which adds nothing at all. Without an endpoint the keyword half is the
 * whole answer — `exact` alone — rather than an error or an empty list.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `knowledge-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const query = "deploy pipeline";
const exact = "## Deploys\n\nThe deploy pipeline runs on every merge.";
const mention = "The deploy script is documented in the handbook.";
const lunch = "Lunch is scheduled for one o'clock.";
let endpoint: EmbeddingEndpoint | undefined;
let embedded: MemoryStore;
let degraded: MemoryStore;

beforeAll(async () => {
  endpoint = await startEmbeddingEndpoint();
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  embedded = createMemoryStore(database, {
    environment: embeddingEnvironment(endpoint.url),
    log: () => {},
  });
  degraded = createMemoryStore(database, { environment: {}, log: () => {} });
});

afterAll(async () => {
  await endpoint?.stop();
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

test("a document is imported once and the query finds its passage", async () => {
  const imported = await embedded.knowledge.import(owner, {
    title: "Handbook",
    text: `${exact}\n\n${mention}`,
    source: "handbook.md",
  });
  expect(imported.title).toBe("Handbook");
  // Both paragraphs fit in one chunk of the 1,200-character budget.
  expect(imported.chunks).toBe(1);
  // The endpoint answered, so every chunk carries a vector.
  expect(imported.embedded).toBe(1);

  const hits = await embedded.knowledge.search(owner, query);
  expect(hits.map((hit) => hit.title)).toEqual(["Handbook"]);
  expect(hits[0]?.content).toContain("deploy pipeline");
  // The keyword half is certain; the vector half is what the endpoint says this chunk shares with
  // the query — less than 1 here, because the chunk carries more words than the query has.
  const shared = cosine(vectorOf(query), vectorOf(hits[0]?.content ?? ""));
  expect(shared).toBeGreaterThan(0);
  expect(hits[0]?.score).toBeCloseTo(0.5 + 0.5 * shared, 6);
  expect(hits[0]?.heading).toBe("Deploys");

  await embedded.knowledge.import(owner, { title: "Lunch", text: lunch });
  const narrowed = await embedded.knowledge.search(owner, query);
  // `lunch` is a vector candidate at best, and its cosine with the query is zero.
  expect(narrowed.map((hit) => hit.title)).toEqual(["Handbook"]);

  const empty = await embedded.knowledge.search(owner, "   ");
  expect(empty).toEqual([]);
});

test("importing the same title again replaces what the document held", async () => {
  await embedded.knowledge.import(owner, {
    title: "Handbook",
    text: "Nothing about merges lives here any more.",
  });
  const hits = await embedded.knowledge.search(owner, query);
  expect(hits).toEqual([]);
  const rows = await database
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.ownerUserId, owner), eq(documents.title, "Handbook")));
  // One row for the title, not a second copy to search through.
  expect(rows).toHaveLength(1);
  // And the replaced text is searchable on its own words.
  const replaced = await embedded.knowledge.search(owner, "merges");
  expect(replaced.map((hit) => hit.content)).toEqual([
    "Nothing about merges lives here any more.",
  ]);
});

test("with no endpoint the same query answers from the words alone", async () => {
  await embedded.knowledge.import(owner, { title: "Merges", text: exact });
  await embedded.knowledge.import(owner, { title: "Runbook", text: mention });
  const withVectors = await embedded.knowledge.search(owner, query);
  const wordsOnly = await degraded.knowledge.search(owner, query);
  // Only the phrase is a keyword hit, so without vectors it is the whole answer.
  expect(wordsOnly.map((hit) => hit.content)).toEqual([exact]);
  expect(wordsOnly[0]?.score).toBeCloseTo(0.5, 6);
  // The endpoint is what puts `mention` in the answer at all: the phrase is not in it.
  expect(withVectors.map((hit) => hit.content)).toEqual([exact, mention]);
  const shared = cosine(vectorOf(query), vectorOf(exact));
  expect(withVectors[0]?.score).toBeCloseTo(0.5 + 0.5 * shared, 6);
  expect(withVectors[1]?.score).toBeGreaterThan(0);
  expect(withVectors[1]?.score).toBeLessThan(0.5);
  // The reversal: the endpoint is the only reason the two answers differ at all.
  expect(withVectors.map((hit) => hit.documentId)).not.toEqual(
    wordsOnly.map((hit) => hit.documentId),
  );
});

test("one person's documents never answer another person's search", async () => {
  const stranger = await degraded.knowledge.search(other, query);
  expect(stranger).toEqual([]);
  const imported = await degraded.knowledge.import(other, {
    title: "Handbook",
    text: "A different handbook, filed by somebody else.",
  });
  expect(imported.chunks).toBe(1);
  // The same title under a second owner is a document of its own, not an update.
  const rows = await database
    .select({ ownerUserId: documents.ownerUserId })
    .from(documents)
    .where(eq(documents.title, "Handbook"));
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.ownerUserId).sort()).toEqual([owner, other].sort());
  // And each search answers with its own owner's text: "handbook" is a word in the runbook the
  // owner imported, and in the other person's document — never in each other's answers.
  const mine = await embedded.knowledge.search(owner, "handbook");
  expect(mine.map((hit) => hit.content)).toEqual([mention]);
  const theirs = await degraded.knowledge.search(other, "handbook");
  expect(theirs.map((hit) => hit.content)).toEqual([
    "A different handbook, filed by somebody else.",
  ]);
});