import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createMemoryStore, type MemoryStore } from "../src/memory/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  embeddingEnvironment,
  startEmbeddingEndpoint,
  type EmbeddingEndpoint,
} from "./support/embeddings";

/**
 * Recall, on a real database with a real endpoint: the same three memories are searched twice, once
 * with vectors and once without, and the answers differ in the way the formula says they will.
 *
 * The query is `deploy pipeline`. Keywords are matched as one substring, so `near` — that sentence —
 * is the keyword hit; `mention` says "deploy" and then waters it down with seven words the query
 * does not have, so the phrase is absent and only the vector channel finds it; `unrelated` shares
 * nothing at all and its vector is orthogonal to the query, which is why it is not a candidate.
 *
 * With an endpoint: `near` first (0.5 keyword + 0.5 × cosine 1.0) and `mention` second on its cosine
 * alone (about 0.11), which is the whole point — recall gains a row the words miss. Without an
 * endpoint the keyword half is all there is, so `near` is the only answer. The score itself is not
 * part of the record: `MemoryRecord` is the shape callers already read, and it is unchanged. The
 * formula is observable in this file through the order and through who is present at all; the
 * knowledge search is where a score is returned to the caller.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memory-retrieval-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const query = "deploy pipeline";
const near = "deploy pipeline";
const mention = "the deploy script is documented in the handbook";
const unrelated = "lunch is scheduled for one o'clock";
const embeddedWarnings: Record<string, unknown>[] = [];
const degradedWarnings: Record<string, unknown>[] = [];
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
    log: (line) => embeddedWarnings.push(line),
  });
  degraded = createMemoryStore(database, {
    environment: {},
    log: (line) => degradedWarnings.push(line),
  });
});

afterAll(async () => {
  await endpoint?.stop();
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

test("the vector half brings in the memory the words miss, behind the one they match", async () => {
  const before = endpoint?.requests() ?? 0;
  const older = await embedded.create(owner, { content: near });
  const newer = await embedded.create(owner, { content: mention });
  await embedded.create(owner, { content: unrelated });
  expect(endpoint?.requests() ?? 0).toBeGreaterThan(before);
  const hits = await embedded.retrieve(owner, [], query);
  expect(hits.map((hit) => hit.content)).toEqual([near, mention]);
  // First: the row the words and the vectors agree on.
  expect(hits[0]?.id).toBe(older.id);
  // Second, and only here because of the vector: the words miss this one entirely.
  expect(hits[1]?.id).toBe(newer.id);
  expect(hits.map((hit) => hit.content)).not.toContain(unrelated);
  // The contract the caller reads is unchanged: a memory record, and nothing new in it.
  expect(hits[0]?.ownerUserId).toBe(owner);
  expect(hits[0]?.reviewState).toBe("confirmed");
  expect(hits[0]?.formedBy).toBe("person");
  expect(Object.keys(hits[0] ?? {})).not.toContain("score");
  // And a person who owns none of this sees none of it.
  expect(await embedded.retrieve(other, [], query)).toEqual([]);
});

test("with no endpoint the same query answers from the words alone", async () => {
  const withVectors = await embedded.retrieve(owner, [], query);
  const hits = await degraded.retrieve(owner, [], query);
  expect(hits.map((hit) => hit.content)).toEqual([near]);
  expect(withVectors.map((hit) => hit.content)).toEqual([near, mention]);
  // The reversal: the endpoint is what puts `mention` in the answer at all.
  expect(withVectors.map((hit) => hit.id)).not.toEqual(hits.map((hit) => hit.id));
  expect(
    degradedWarnings.filter((line) => line.type === "memory-embedding-absent"),
  ).toHaveLength(1);
  expect(
    embeddedWarnings.filter((line) => line.type === "memory-embedding-absent"),
  ).toHaveLength(0);
});

test("a search with no words is the list it always was", async () => {
  const hits = await embedded.retrieve(owner, []);
  expect(hits.map((hit) => hit.content)).toEqual([unrelated, mention, near]);
});