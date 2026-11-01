/*
 * `send`: one message from the window, driven through the agent that actually runs, and the feed
 * events that come back.
 *
 * The turn goes to the copilot handler in this process — the same object mounted at `/` for the
 * browser (`app.ts`'s `app.route("/", copilotHandler)`) — with the caller's own headers and cookie
 * forwarded verbatim. That is the whole point: the runtime resolves the person from the request, so
 * the message reaches the same agent, under the same ownership, as one typed into CCP-Bot's own
 * window. No synthesized user, no second authentication path, no direct call into a runner that
 * bypasses the checks the route performs.
 *
 * The answer arrives the way DS-Bot's client expects it (`src/host/feed.js:85-102`): a `stream` event
 * at the start, one per text delta, one at the end — and a `message` event per transcript item once
 * the turn is over. `ok(true)` returns as soon as the run was accepted, because that is what DS-Bot
 * answers (`src/host/channel.js:414-429`); the answer itself travels on the feed.
 */

import { randomUUID } from "node:crypto";
import { transcriptItems } from "./chat";
import type { BotEnvelope } from "./envelope";
import { fail, ok } from "./envelope";
import type { BotChannelContext } from "./state";
import { liveValue, sessionIdsFor } from "./state";

/** One SSE frame's worth of parsing: the AG-UI events this arm understands, and nothing else. */
type RunEvent = { type?: string; delta?: string };

/**
 * Hand one message to the agent, and let the answer come back on the feed.
 *
 * What the caller can act on is answered here. A turn that fails after the POST was accepted is
 * reported on the feed — as the end of its stream — rather than as a failed request, because by then
 * the request is long answered.
 */
export async function sendMessage(
  context: BotChannelContext,
  payload: Record<string, unknown>,
): Promise<BotEnvelope> {
  const { deps, actor, request } = context;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const sessionId = payload.sessionId;
  if (text === "" || typeof sessionId !== "string" || sessionId === "") {
    return fail("Nothing to send", "bot/invalid");
  }

  const profiles = await deps.agents.list(actor);
  const sessions = await sessionIdsFor(deps, actor, profiles);
  const botId = [...sessions.entries()].find(([, id]) => id === sessionId)?.[0];
  if (botId === undefined) return fail("Unknown conversation", "bot/not-found");

  const attemptId = randomUUID();
  const before = await deps.threads.messages(sessionId, actor.id);

  /*
   * The headers a browser would have sent, minus the two that describe this request rather than the
   * caller: `content-length` because this body is not the one that arrived, and `host` because the
   * handler is reached in-process rather than over a socket. Everything else — above all the session
   * cookie — is the caller's own.
   */
  const response = await deps.run(
    new Request(new URL(`/api/copilotkit/agent/${botId}/run`, request.url), {
      method: "POST",
      headers: forwarded(request),
      body: JSON.stringify({
        threadId: sessionId,
        runId: randomUUID(),
        state: {},
        messages: [{ id: randomUUID(), role: "user", content: text }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    }),
  );

  if (!response.ok) {
    return fail(
      `The agent refused the turn (HTTP ${response.status}).`,
      response.status === 404 ? "bot/not-found" : "bot/refused",
    );
  }

  // Detached on purpose: the POST is answered now, and the transcript arrives as it happens.
  void follow(context, { response, botId, sessionId, attemptId, text, before }).catch(
    (error) => {
      console.error(
        JSON.stringify({
          type: "bot-channel-send-follow-failed",
          botId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  );

  deps.feed.live(liveValue([botId]));
  return ok(true);
}

/** Read the run's SSE and republish it as the two feed events the client switches on. */
async function follow(
  context: BotChannelContext,
  turn: {
    response: Response;
    botId: string;
    sessionId: string;
    attemptId: string;
    text: string;
    before: Record<string, unknown>[];
  },
): Promise<void> {
  const { deps, actor } = context;
  const body = turn.response.body;
  if (body === null) return;

  deps.feed.publish("stream", {
    botId: turn.botId,
    sessionId: turn.sessionId,
    attemptId: turn.attemptId,
    phase: "start",
  });

  const answer: string[] = [];
  for await (const event of readRunEvents(body)) {
    if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") {
      answer.push(event.delta);
      deps.feed.publish("stream", {
        botId: turn.botId,
        sessionId: turn.sessionId,
        attemptId: turn.attemptId,
        text: event.delta,
      });
    }
  }

  deps.feed.publish("stream", {
    botId: turn.botId,
    sessionId: turn.sessionId,
    attemptId: turn.attemptId,
    phase: "end",
  });

  /*
   * The items for what just happened, read back from this deployment's own store when it has them.
   *
   * A deployment holding conversations itself (`threads`) has the turn stored by the time the run
   * ends, so the transcript the client renders is the one the database holds. A deployment whose
   * conversations live in CopilotKit Intelligence has nothing local to read, and there the items are
   * the two things that were observed here — what was sent, and the text that came back — rather than
   * a store lookup that returns empty and leaves the window with no answer at all.
   */
  const after = await deps.threads.messages(turn.sessionId, actor.id);
  const stored = after.length > turn.before.length ? after.slice(turn.before.length) : [];
  const items =
    stored.length > 0
      ? transcriptItems(stored)
      : transcriptItems([
          { role: "user", content: turn.text },
          { role: "assistant", content: answer.join("") },
        ]);
  for (const item of items) {
    deps.feed.publish("message", {
      botId: turn.botId,
      sessionId: turn.sessionId,
      item,
    });
  }
  deps.feed.live(liveValue([]));
}

/** The caller's headers, with the two that describe this process's own request replaced. */
function forwarded(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("host");
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  return headers;
}

/** AG-UI's SSE frames, as data lines. */
async function* readRunEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data !== "") {
        try {
          yield JSON.parse(data) as RunEvent;
        } catch {
          // A frame that is not JSON is not one of ours; keep reading.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}