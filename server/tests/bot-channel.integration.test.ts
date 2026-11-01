/*
 * The bot channel over a real database and a real agent.
 *
 * The unit tests cover the envelope, the preference rules and the framing; this covers the claim the
 * phase rests on — that DS-Bot's two routes are served from what this deployment already holds. The
 * roster comes out of `AgentProfileStore`, the conversation out of `ThreadStore`, and a `send` goes
 * through the runtime's own handler to an AG-UI agent that really speaks the protocol
 * (`@copilotkit/aimock`, the same mock the agent-facing tests use). Nothing is stubbed except the
 * agent endpoint and the middleware that would otherwise read a session cookie.
 *
 * The feed is read the way the client reads it: a subscriber on the channel's own feed, frames
 * parsed out of the stream.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HttpAgent } from "@ag-ui/client";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { eq, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createBotChannel, createBotChannelRoutes } from "../src/bot-channel";
import { readDocument } from "../src/bot-channel/document";
import type { BotEnvelope } from "../src/bot-channel/envelope";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createThreadStore } from "../src/threads/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { standaloneEnvironment } from "./support/environment";

const prefix = `bot-channel-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const conversation = `${prefix}-conversation`;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
// No managed-agent endpoint: this deployment's roster is served from its own rows, and the store's
// second argument only decides whether customer agents are dialled at all.
const profileStore = createAgentProfileStore(database, undefined);
const threadStore = createThreadStore(database);
const mock = new AGUIMock();
let mockUrl = "";
let botId = "";

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  mock.onRun(/.*/, [
    { type: "RUN_STARTED", threadId: conversation, runId: "run-1" },
    { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "KEPT" },
    { type: "TEXT_MESSAGE_END", messageId: "reply" },
    { type: "RUN_FINISHED", threadId: conversation, runId: "run-1" },
  ] as never);
  mockUrl = await mock.start();
  const profile = await profileStore.create(
    { id: owner, role: "admin" },
    {
      name: "Desk",
      title: "Runs the desk",
      roleDescription: "Answer plainly.",
      visibility: "private",
      // Its own endpoint, which is what a deployment with no managed Bot needs: the mock below.
      endpoint: `${mockUrl}/`,
    },
  );
  botId = profile.id;
});

afterAll(async () => {
  await mock.stop?.();
  // Cascades to this person's Bots and conversations: both tables reference users.
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(users).where(eq(users.id, other));
  await database.$client.close();
});

/** One person's view of the channel: the routes they reach, and the feed they follow. */
function channelFor(actorId: string) {
  const runtime = mountCopilotRuntime(
    loadConfig(standaloneEnvironment()),
    {
      resolveAgentsForActor: async () => ({
        [botId]: new HttpAgent({ url: `${mockUrl}/`, agentId: botId }),
      }),
      resolveAgentForActor: async () =>
        new HttpAgent({ url: `${mockUrl}/`, agentId: botId }),
    },
    async () => ({ id: actorId, name: "Bot channel test" }),
    async () => ({ id: actorId, role: "admin" }),
    { threads: threadStore },
  );
  const deps = createBotChannel({
    database,
    agents: profileStore,
    threads: threadStore,
    handler: runtime.handler,
  });
  // What `auth/guards.ts` does for every other route: put the person on the context.
  const requireUser = async (context: never, next: () => Promise<void>) => {
    (context as { set: (key: string, value: unknown) => void }).set("actor", {
      id: actorId,
      role: "admin",
    });
    await next();
  };
  return {
    deps,
    routes: createBotChannelRoutes(deps, requireUser as never),
  };
}

async function post(
  routes: ReturnType<typeof channelFor>["routes"],
  endpoint: string,
  payload: unknown,
) {
  const response = await routes.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "session=abc" },
    body: JSON.stringify({ endpoint, payload }),
  });
  return {
    status: response.status,
    body: (await response.json()) as BotEnvelope,
  };
}

/**
 * The payload of an answer these tests expect to be `ok`.
 *
 * `BotEnvelope` is a union, so `value` is not readable until the answer is narrowed. A refusal here
 * fails the test with the code it carried instead of with a missing property.
 */
function valueOf(body: BotEnvelope): unknown {
  if (!body.ok) throw new Error(`Expected an ok answer, got ${body.error.code}`);
  return body.value;
}

/** The frames a subscriber is sent, in order, read the way `EventSource` reads them. */
function follow(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: { event: string; data?: unknown }[] = [];
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (event) {
          frames.push({ event, data: data ? JSON.parse(data) : undefined });
        }
        end = buffer.indexOf("\n\n");
      }
    }
  })();
  return {
    frames,
    stop: () => void reader.cancel(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("The feed never carried the frames this test waits for.");
}

const ownerChannel = channelFor(owner);

describe("DS-Bot's routes over this deployment's own data", () => {
  test("state answers with the Bots this person has, each with a conversation", async () => {
    const { status, body } = await post(ownerChannel.routes, "state", {});

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const value = valueOf(body) as unknown as {
      workspaceId: string;
      bots: { id: string; name: string; sessionId: string }[];
      revision: number;
      readOnly: boolean;
    };
    expect(value.workspaceId).toBe(`ccpbot:${owner}`);
    expect(value.readOnly).toBe(false);
    expect(value.bots.map((bot) => bot.id)).toContain(botId);
    expect(value.bots.find((bot) => bot.id === botId)?.name).toBe("Desk");
    // A conversation exists for it: the client cannot ask for one of its own.
    expect(
      value.bots.find((bot) => bot.id === botId)?.sessionId,
    ).toBeString();
  });

  test("set-prefs saves into this deployment's row and tells the feed", async () => {
    const followed = follow(ownerChannel.deps.feed.subscribe({ revision: 0 }));
    const { body } = await post(ownerChannel.routes, "set-prefs", {
      theme: "midnight",
      accent: "#a1b2c3",
      motion: "quiet",
      layout: "flat",
      width: 70,
      flatWidth: 60,
      thinking: true,
    });

    expect(body).toEqual({
      ok: true,
      value: {
        theme: "midnight",
        accent: "#a1b2c3",
        motion: "quiet",
        layout: "flat",
        width: 70,
        flatWidth: 60,
        thinking: true,
      },
    });
    // It is in the person's own row, which is what makes it survive a reload.
    const document = await readDocument(database, owner);
    expect(document.prefs).toEqual({
      theme: "midnight",
      accent: "#a1b2c3",
      motion: "quiet",
      layout: "flat",
      width: 70,
      flatWidth: 60,
      thinking: true,
    });
    expect(document.revision).toBe(1);
    await waitFor(() => followed.frames.some((f) => f.event === "revision"));

    const state = await post(ownerChannel.routes, "state", {});
    expect((valueOf(state.body) as unknown as { prefs: unknown }).prefs).toEqual(
      document.prefs,
    );
    followed.stop();
  });

  test("leaves the deployment's own preference keys where they are", async () => {
    // A key CCP-Bot itself owns, merged in the way its own preference routes merge one
    // (`user-preferences.ts`: the column is a bag per person, merged in Postgres).
    await database
      .update(users)
      .set({
        preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || ${{ theme: "dark" }}::jsonb`,
      })
      .where(eq(users.id, owner));

    await post(ownerChannel.routes, "set-prefs", { accent: "#123456" });

    const [row] = await database
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, owner));
    const preferences = row?.preferences as unknown as Record<string, unknown>;
    expect(preferences.theme).toBe("dark");
    expect(
      (preferences.dsBot as { prefs: Record<string, unknown> }).prefs,
    ).toMatchObject({ accent: "#123456", theme: "midnight" });
  });

  test("a message reaches the agent and its answer streams and lands in the conversation", async () => {
    const state = await post(ownerChannel.routes, "state", {});
    const value = valueOf(state.body) as unknown as {
      bots: { id: string; sessionId: string }[];
    };
    const sessionId = value.bots.find((bot) => bot.id === botId)?.sessionId ?? "";
    const followed = follow(ownerChannel.deps.feed.subscribe({ revision: 1 }));

    const { body } = await post(ownerChannel.routes, "send", {
      sessionId,
      text: "keep this",
    });
    expect(body).toEqual({ ok: true, value: true });

    await waitFor(() =>
      followed.frames.some(
        (frame) =>
          frame.event === "stream" &&
          (frame.data as { phase?: string }).phase === "end",
      ),
    );
    const stream = followed.frames.filter((frame) => frame.event === "stream");
    expect(
      stream.map((frame) => (frame.data as { phase?: string }).phase).filter(Boolean),
    ).toEqual(["start", "end"]);
    expect(
      stream
        .map((frame) => (frame.data as { text?: string }).text)
        .filter((text): text is string => typeof text === "string")
        .join(""),
    ).toBe("KEPT");

    // The turn is in the deployment's own conversation table, both halves of it.
    const messages = await threadStore.messages(sessionId, owner);
    expect(
      messages.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "keep this"],
      ["assistant", "KEPT"],
    ]);
    await waitFor(() =>
      followed.frames.some((frame) => frame.event === "message"),
    );
    expect(
      followed.frames
        .filter((frame) => frame.event === "message")
        .map((frame) => (frame.data as { item: { text: string } }).item.text),
    ).toEqual(["keep this", "KEPT"]);
    followed.stop();
  });

  test("chat answers the conversation's own items", async () => {
    const { body } = await post(ownerChannel.routes, "chat", { botId });

    expect(body.ok).toBe(true);
    const value = valueOf(body) as unknown as {
      sessionId: string;
      items: { kind: string; text: string }[];
      cursor: unknown;
    };
    expect(value.items.map((item) => [item.kind, item.text])).toEqual([
      ["user", "keep this"],
      ["bot", "KEPT"],
    ]);
    expect(value.cursor).toBeNull();
  });

  test("state short-circuits when the client already has this revision", async () => {
    const first = await post(ownerChannel.routes, "state", {});
    const revision = (valueOf(first.body) as unknown as { revision: number })
      .revision;

    const { body } = await post(ownerChannel.routes, "state", {
      since: revision,
    });

    expect(body.ok).toBe(true);
    const value = valueOf(body) as unknown as {
      unchanged?: boolean;
      revision: number;
      bots?: unknown;
    };
    expect(value.unchanged).toBe(true);
    expect(value.revision).toBe(revision);
    expect(value.bots).toBeUndefined();
  });

  test("another person reaches neither these Bots nor these conversations", async () => {
    const stranger = channelFor(other);
    const state = await post(stranger.routes, "state", {});
    expect(
      (valueOf(state.body) as unknown as { bots: { id: string }[] }).bots.map(
        (bot) => bot.id,
      ),
    ).not.toContain(botId);

    const chat = await post(stranger.routes, "chat", { botId });
    expect(chat.body).toEqual({
      ok: false,
      error: { code: "bot/not-found", message: "Unknown Bot", details: {} },
    });

    const sessionId = await conversationOf(ownerChannel.routes);
    const send = await post(stranger.routes, "send", {
      sessionId,
      text: "whose is this",
    });
    expect(send.body).toEqual({
      ok: false,
      error: {
        code: "bot/not-found",
        message: "Unknown conversation",
        details: {},
      },
    });
    // Nothing was run: the owner's conversation still holds only their own turn.
    expect(
      (await threadStore.messages(sessionId, owner)).map(
        (message) => message.content,
      ),
    ).toEqual(["keep this", "KEPT"]);
  });
});

async function conversationOf(
  routes: ReturnType<typeof channelFor>["routes"],
): Promise<string> {
  const { body } = await post(routes, "state", {});
  const value = valueOf(body) as unknown as {
    bots: { id: string; sessionId: string }[];
  };
  return value.bots.find((bot) => bot.id === botId)?.sessionId ?? "";
}