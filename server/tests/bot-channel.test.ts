/*
 * The bot channel's own behaviour, without a database and without an agent.
 *
 * What these cover is the part DS-Bot's client cannot re-derive: the envelope and its codes, the
 * preference rules it shows messages from, the SSE framing it reads events out of, the short-circuit
 * it relies on to notice nothing changed, and that a message reaches `run` with the caller's own
 * headers. The end-to-end evidence — a real server, a real agent, a real feed — is
 * `bot-channel.integration.test.ts`, which needs PostgreSQL.
 */

import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createBotChannelRoutes } from "../src/bot-channel";
import type { BotChannelDocument } from "../src/bot-channel/document";
import {
  type BotEnvelope,
  errorCode,
  fail,
  invalid,
  ok,
  refusal,
} from "../src/bot-channel/envelope";
import { KEEPALIVE, createBotFeed, frame } from "../src/bot-channel/feed";

const USER = "bot-channel-test-user";
const BOT = "bot-channel-test-bot";
const THREAD = "bot-channel-test-thread";

type Stub = {
  routes: Hono<{ Variables: AppVariables }>;
  published: { event: string; data: unknown }[];
  sent: { text: string; headers: Headers; url: string }[];
  document: BotChannelDocument;
  runResponse: () => Response;
};

function stub(overrides: { document?: Partial<BotChannelDocument> } = {}): Stub {
  const published: { event: string; data: unknown }[] = [];
  const sent: { text: string; headers: Headers; url: string }[] = [];
  let document: BotChannelDocument = {
    version: 1,
    mainBotIds: [BOT],
    prefs: {},
    revision: 3,
    ...overrides.document,
  };
  let runResponse = (): Response =>
    new Response(
      [
        'data: {"type":"RUN_STARTED"}',
        "",
        'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hello "}',
        "",
        'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"there"}',
        "",
        'data: {"type":"RUN_FINISHED"}',
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  const deps = {
    document: {
      read: async () => document,
      update: async (
        _userId: string,
        mutate: (current: BotChannelDocument) => BotChannelDocument,
      ) => {
        const before = document;
        document = { ...mutate(before), revision: before.revision + 1 };
        return document;
      },
    },
    agents: {
      list: async () => [
        {
          id: BOT,
          name: "Ops",
          title: "Runs the desk",
          roleDescription: "Answer plainly.",
          avatarSeed: "seed",
          ownerUserId: USER,
          systemOwned: false,
          assignedToMe: false,
        },
      ],
    },
    threads: {
      list: async () => [
        { id: THREAD, agentId: BOT, createdAt: new Date(), updatedAt: new Date() },
      ],
      messages: async () => [{ role: "user", content: "what is kept" }],
      record: async () => {},
    },
    run: async (request: Request) => {
      sent.push({
        text: await request.clone().text(),
        headers: request.headers,
        url: request.url,
      });
      return runResponse();
    },
    feed: {
      publish: (event: string, data: unknown) => {
        published.push({ event, data });
      },
      live: () => {},
      subscribe: () => new ReadableStream<Uint8Array>(),
      subscribers: () => 0,
      stop: () => {},
    },
    newThreadId: () => "bot-channel-test-new-thread",
  };

  const requireUser = async (context: never, next: () => Promise<void>) => {
    (context as { set: (key: string, value: unknown) => void }).set("actor", {
      id: USER,
      role: "admin",
    });
    await next();
  };

  return {
    routes: createBotChannelRoutes(
      deps as unknown as Parameters<typeof createBotChannelRoutes>[0],
      requireUser as never,
    ),
    published,
    sent,
    get document() {
      return document;
    },
    set runResponse(value: () => Response) {
      runResponse = value;
    },
  };
}

async function post(
  routes: Hono<{ Variables: AppVariables }>,
  endpoint: string,
  payload: unknown = {},
): Promise<{ status: number; body: BotEnvelope }> {
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

describe("the envelope", () => {
  test("answers and refusals carry the shape the client reads", () => {
    expect(ok(true)).toEqual({ ok: true, value: true });
    expect(fail("Nothing to send", "bot/invalid")).toEqual({
      ok: false,
      error: { code: "bot/invalid", message: "Nothing to send", details: {} },
    });
  });

  test("classifies the way DS-Bot classifies", () => {
    expect(errorCode(invalid("Unknown theme"))).toBe("bot/invalid");
    expect(errorCode(new TypeError("boom"))).toBe("bot/internal");
    expect(
      errorCode(Object.assign(new Error("gone"), { code: "ENOENT" })),
    ).toBe("bot/internal");
    expect(errorCode(new Error("nope"))).toBe("bot/refused");
    expect(refusal(new Error("nope"))).toEqual({
      ok: false,
      error: { code: "bot/refused", message: "nope", details: {} },
    });
  });
});

describe("the feed", () => {
  test("frames an event the way an EventSource reads it", () => {
    expect(frame("hello", { revision: 3 })).toBe(
      'event: hello\ndata: {"revision":3}\n\n',
    );
    expect(KEEPALIVE).toBe(": keepalive\n\n");
  });

  test("opens with hello and then carries what is published", async () => {
    const feed = createBotFeed({ keepaliveMs: 10_000 });
    const stream = feed.subscribe({ revision: 3 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(
      'event: hello\ndata: {"revision":3}\n\n',
    );
    feed.publish("stream", { text: "hi" });
    expect(decoder.decode((await reader.read()).value)).toBe(
      'event: stream\ndata: {"text":"hi"}\n\n',
    );
    feed.stop();
    await reader.cancel();
  });

  test("coalesces the live bursts DS-Bot also coalesces", async () => {
    const feed = createBotFeed({ liveDelayMs: 5 });
    const reader = feed.subscribe({}).getReader();
    await reader.read();
    feed.live({ work: { bots: ["a"] } });
    feed.live({ work: { bots: ["b"] } });
    await Bun.sleep(20);
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(
      'event: live\ndata: {"work":{"bots":["b"]}}\n\n',
    );
    feed.stop();
    await reader.cancel();
  });
});

describe("the routes", () => {
  test("refuses an endpoint this phase has not implemented, by name", async () => {
    const { routes } = stub();
    const response = await post(routes, "schedules");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: "bot/not-found",
        message: "Unknown endpoint schedules",
        details: {},
      },
    });
  });

  test("refuses a payload with no endpoint", async () => {
    const { routes } = stub();
    const response = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "bot/invalid", message: "Missing endpoint", details: {} },
    });
  });

  test("answers state with this deployment's own roster and conversations", async () => {
    const { routes } = stub();
    const { body } = await post(routes, "state");
    const value = valueOf(body) as Record<string, unknown>;
    expect(value.revision).toBe(3);
    expect(value.workspaceId).toBe(`ccpbot:${USER}`);
    expect(value.mainBotId).toBe(BOT);
    expect(value.bots).toEqual([
      {
        id: BOT,
        name: "Ops",
        role: "Runs the desk",
        instructions: "Answer plainly.",
        avatar: "seed",
        sessionId: THREAD,
      },
    ]);
    expect(value.readOnly).toBe(false);
  });

  test("short-circuits a state the client already has", async () => {
    const { routes } = stub();
    const { body } = await post(routes, "state", { since: 3 });
    const value = valueOf(body) as Record<string, unknown>;
    expect(value.unchanged).toBe(true);
    expect(value.revision).toBe(3);
    expect(value.bots).toBeUndefined();
  });

  test("saves preferences and answers with them", async () => {
    const channel = stub();
    const { body } = await post(channel.routes, "set-prefs", {
      theme: "midnight",
      accent: "#a1b2c3",
      width: 70,
    });
    expect(body).toEqual({
      ok: true,
      value: { theme: "midnight", accent: "#a1b2c3", width: 70 },
    });
    expect(channel.document.revision).toBe(4);
    expect(channel.published).toEqual([
      { event: "revision", data: { revision: 4 } },
    ]);
  });

  test("refuses a preference the client would not have sent", async () => {
    const { routes } = stub();
    const { body } = await post(routes, "set-prefs", { width: 20 });
    expect(body).toEqual({
      ok: false,
      error: {
        code: "bot/invalid",
        message: "Width must be a whole percent from 50 to 100",
        details: {},
      },
    });
  });

  test("answers a chat with the conversation's items", async () => {
    const { routes } = stub();
    const { body } = await post(routes, "chat", { botId: BOT });
    expect(body).toEqual({
      ok: true,
      value: {
        sessionId: THREAD,
        items: [{ kind: "user", text: "what is kept" }],
        cursor: null,
      },
    });
  });

  test("refuses a chat for a bot this person does not have", async () => {
    const { routes } = stub();
    const { body } = await post(routes, "chat", { botId: "somebody-else" });
    expect(body).toEqual({
      ok: false,
      error: { code: "bot/not-found", message: "Unknown Bot", details: {} },
    });
  });

  test("refuses a send with nothing to send", async () => {
    const { routes, sent } = stub();
    const { body } = await post(routes, "send", { sessionId: THREAD, text: "   " });
    expect(body).toEqual({
      ok: false,
      error: { code: "bot/invalid", message: "Nothing to send", details: {} },
    });
    expect(sent).toEqual([]);
  });

  test("refuses a send into a conversation that is not this person's", async () => {
    const { routes, sent } = stub();
    const { body } = await post(routes, "send", {
      sessionId: "somebody-else-thread",
      text: "hello",
    });
    expect(body).toEqual({
      ok: false,
      error: { code: "bot/not-found", message: "Unknown conversation", details: {} },
    });
    expect(sent).toEqual([]);
  });

  test("sends a message to the agent with the caller's own headers", async () => {
    const { routes, sent } = stub();
    const { body } = await post(routes, "send", { sessionId: THREAD, text: "hello" });
    expect(body).toEqual({ ok: true, value: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain(`/api/copilotkit/agent/${BOT}/run`);
    expect(sent[0]?.headers.get("cookie")).toBe("session=abc");
    expect(sent[0]?.headers.get("host")).toBeNull();
    const request = JSON.parse(sent[0]?.text as string) as {
      threadId: string;
      messages: { role: string; content: string }[];
    };
    expect(request.threadId).toBe(THREAD);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content).toBe("hello");
  });

  test("reports the answer on the feed as far as it got", async () => {
    const { routes, published } = stub();
    await post(routes, "send", { sessionId: THREAD, text: "hello" });
    // The follow-up runs detached; give it the turns it needs.
    await Bun.sleep(50);
    const phases = published
      .filter((entry) => entry.event === "stream")
      .map((entry) => (entry.data as { phase?: string }).phase)
      .filter((phase): phase is string => typeof phase === "string");
    expect(phases).toEqual(["start", "end"]);
    const text = published
      .map((entry) => (entry.data as { text?: string }).text)
      .filter((value): value is string => typeof value === "string");
    expect(text).toEqual(["hello ", "there"]);
    expect(published.filter((entry) => entry.event === "message")).toHaveLength(2);
  });

  test("answers a refused run with the code the client acts on", async () => {
    const refused = stub();
    refused.runResponse = () => new Response("no", { status: 403 });
    const { body } = await post(refused.routes, "send", {
      sessionId: THREAD,
      text: "hello",
    });
    expect(body).toEqual({
      ok: false,
      error: {
        code: "bot/refused",
        message: "The agent refused the turn (HTTP 403).",
        details: {},
      },
    });
  });
});