import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HttpAgent } from "@ag-ui/client";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  createStoredThreadReader,
  createThreadStore,
  type ThreadStore,
} from "../src/threads/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { standaloneEnvironment } from "./support/environment";

/**
 * A conversation that outlives the process that had it.
 *
 * What is under test is the runner `mountCopilotRuntime` builds in SSE mode, driven the way the
 * product drives it: a run posted to the runtime's own handler over a real HTTP request body,
 * against an AG-UI agent that really speaks the protocol (`@copilotkit/aimock`, ours — the same mock
 * the agent-facing tests use) rather than a stubbed fetch. The agent is the only stand-in; the
 * runtime, the runner, the store and the database are the ones a deployment gets.
 *
 * Then the claim itself: an instance built afterwards — new store, new runner, new runtime, nothing
 * carried across in memory — reads the conversation back out of PostgreSQL. That is what "the
 * window reopens and the conversation is still there" means, and it is the thing the SDK does not
 * promise: its in-memory runner keeps a process-level store, and its own local thread endpoints read
 * synchronously (`LocalThreadEndpointRunner` in `runner/agent-runner.d.mts`), so a deployment that
 * wants a conversation to survive a restart keeps it itself.
 */

const BOT = "threads-integration-bot";
const prefix = `threads-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const conversation = `${prefix}-conversation`;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const mock = new AGUIMock();
let mockUrl = "";

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  /*
   * A well-behaved agent for a trivial run, the shape `agent-connection-live.test.ts` uses: it
   * starts, says one thing, finishes. The text is what the conversation must end up holding.
   */
  mock.onRun(/.*/, [
    { type: "RUN_STARTED", threadId: conversation, runId: "run-1" },
    { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "KEPT" },
    { type: "TEXT_MESSAGE_END", messageId: "reply" },
    { type: "RUN_FINISHED", threadId: conversation, runId: "run-1" },
  ] as never);
  mockUrl = await mock.start();
});

afterAll(async () => {
  await mock.stop?.();
  // Cascades to anything the conversation rows hold: threads references users.
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(users).where(eq(users.id, other));
  await database.$client.close();
});

/** One instance's worth of everything a read goes through. */
function mount(store: ThreadStore, actorId: string) {
  const agent = () => new HttpAgent({ url: `${mockUrl}/`, agentId: BOT });
  return mountCopilotRuntime(
    loadConfig(standaloneEnvironment()),
    {
      resolveAgentsForActor: async () => ({ [BOT]: agent() }),
      resolveAgentForActor: async () => agent(),
    },
    async () => ({ id: actorId, name: "Threads test" }),
    async () => ({ id: actorId, role: "admin" }),
    { threads: store },
  );
}

function runRequest(threadId: string) {
  return new Request(`http://ccpbot.test/api/copilotkit/agent/${BOT}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      runId: `run-${threadId}`,
      state: {},
      messages: [{ id: "asked", role: "user", content: "keep this" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
}

/** A run only finishes when its stream is read, so the body is drained before anything is asserted. */
async function run(mounted: ReturnType<typeof mount>, threadId: string) {
  const response = await mounted.handler.fetch(runRequest(threadId));
  const body = await response.text();
  return { response, body };
}

const pairs = (messages: { role?: string; content?: unknown }[]) =>
  messages.map((message) => [message.role, message.content]);

describe("a conversation this deployment keeps itself", () => {
  test("a run through the runtime leaves it in this deployment's tables", async () => {
    const store = createThreadStore(database);
    const mounted = mount(store, owner);

    const { response } = await run(mounted, conversation);

    expect(response.status).toBe(200);
    expect(pairs(await store.messages(conversation, owner))).toEqual([
      ["user", "keep this"],
      ["assistant", "KEPT"],
    ]);
    expect(await store.known(conversation, owner)).toBe(true);
  });

  test("the next instance reads it back, with nothing shared but the database", async () => {
    // Written again by an instance of its own, so this test stands even when run alone.
    await run(mount(createThreadStore(database), owner), conversation);

    /*
     * Everything the read goes through is built fresh here: a new store, and a runtime whose runner
     * was just constructed. The SDK's in-memory store is a module-level singleton, so a read that
     * went through it would pass this without a database — which is exactly why the assertions
     * below go through the store the product reads, and why "the process restarted" is also
     * demonstrated with two real server processes in the report beside this file.
     */
    const store = createThreadStore(database);
    const mounted = mount(store, owner);

    expect((await store.list(owner)).map((thread) => thread.id)).toContain(
      conversation,
    );
    expect(await createStoredThreadReader(store)(conversation, owner)).toBe(
      "known",
    );
    expect(
      pairs(
        (await mounted.history({
          threadId: conversation,
          actorId: owner,
        })) as unknown as { role?: string; content?: unknown }[],
      ),
    ).toEqual([
      ["user", "keep this"],
      ["assistant", "KEPT"],
    ]);
    // Two runs of one conversation are one conversation: the snapshot replaces, it does not append.
    expect(await store.messages(conversation, owner)).toHaveLength(2);
  });
});

describe("a conversation somebody else owns", () => {
  test("is not read back to them, and is not theirs to run on", async () => {
    const store = createThreadStore(database);

    expect(await store.messages(conversation, other)).toEqual([]);
    expect(await createStoredThreadReader(store)(conversation, other)).toBe(
      "unknown",
    );

    const mounted = mount(store, other);
    const { response, body } = await run(mounted, conversation);

    /*
     * 404 rather than 403, and that is the SDK's own answer rather than ours: a thread somebody else
     * owns is refused exactly as one that does not exist (`threadAccessDeniedResponse` in
     * `handlers/shared/thread-access.mjs`), so a refusal never tells a stranger that the
     * conversation is there.
     */
    expect(response.status).toBe(404);
    expect(body).toContain("Thread not found");
    // The owner's own copy is untouched by the attempt.
    expect(await store.messages(conversation, owner)).toHaveLength(2);
  });
});