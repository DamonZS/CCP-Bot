import { expect, test } from "bun:test";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createKnowledgeRoutes } from "../src/memory/knowledge/routes";
import type {
  KnowledgeHit,
  KnowledgeStore,
} from "../src/memory/knowledge/store";
import { KnowledgeRefusedError } from "../src/memory/knowledge/store";

const ACTOR = { id: "person", email: "person@example.test", role: "admin" } as AuthenticatedActor;

function mount(store: Partial<KnowledgeStore>) {
  return createKnowledgeRoutes(store as KnowledgeStore, async (context, next) => {
    context.set("actor", ACTOR);
    await next();
  });
}

test("importing a document answers 201 with what was stored", async () => {
  const imported: Array<{ owner: string; input: unknown }> = [];
  const routes = mount({
    import: async (ownerUserId, input) => {
      imported.push({ owner: ownerUserId, input });
      return { documentId: "doc-1", title: "Handbook", chunks: 3, embedded: 3 };
    },
  });
  const response = await routes.request("/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Handbook", text: "Deploys." }),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    documentId: "doc-1",
    title: "Handbook",
    chunks: 3,
    embedded: 3,
  });
  // The store is asked on behalf of the actor the middleware resolved, not of a caller-supplied id.
  expect(imported).toEqual([
    { owner: ACTOR.id, input: { title: "Handbook", text: "Deploys." } },
  ]);
});

test("a search without a query is refused with the reason, not answered empty", async () => {
  let searches = 0;
  const routes = mount({
    search: async () => {
      searches += 1;
      return [];
    },
  });
  const response = await routes.request("/search?q=%20");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Supply a query to search for.",
  });
  expect(searches).toBe(0);
});

test("a search passes the query and a positive limit to the store", async () => {
  const asked: Array<{ query: string; limit: number | undefined }> = [];
  const hit: KnowledgeHit = {
    documentId: "doc-1",
    title: "Handbook",
    position: 0,
    heading: "Deploys",
    content: "The deploy pipeline runs on merge.",
    score: 1,
  };
  const routes = mount({
    search: async (_owner, query, limit) => {
      asked.push({ query, limit });
      return [hit];
    },
  });
  expect(await (await routes.request("/search?q=deploy%20pipeline")).json()).toEqual({
    results: [hit],
  });
  await routes.request("/search?q=deploy&limit=3");
  // Anything that is not a positive number leaves the store's own default in place.
  await routes.request("/search?q=deploy&limit=nonsense");
  expect(asked).toEqual([
    { query: "deploy pipeline", limit: undefined },
    { query: "deploy", limit: 3 },
    { query: "deploy", limit: undefined },
  ]);
});

test("a document that is not JSON is refused before the store sees it", async () => {
  let imports = 0;
  const routes = mount({
    import: async () => {
      imports += 1;
      return { documentId: "d", title: "t", chunks: 1, embedded: 0 };
    },
  });
  const wrongType = await routes.request("/documents", {
    method: "POST",
    body: "title=Handbook",
  });
  expect(wrongType.status).toBe(400);
  expect(await wrongType.json()).toEqual({
    error: "Supply a document as JSON.",
  });
  const broken = await routes.request("/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(broken.status).toBe(400);
  expect(await broken.json()).toEqual({
    error: "The document could not be read.",
  });
  expect(imports).toBe(0);
});

test("a refusal from the store travels as 400 and anything else as 503", async () => {
  const refusing = mount({
    import: async () => {
      throw new KnowledgeRefusedError("A document needs a title.");
    },
  });
  const refused = await refusing.request("/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "No title." }),
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "A document needs a title." });

  const failing = mount({
    search: async () => {
      throw new TypeError("the database is gone");
    },
  });
  const failed = await failing.request("/search?q=deploy");
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    error: "Knowledge is unavailable. Try again.",
  });
});