/*
 * `POST /api/bot` and `GET /api/bot/feed`, the two routes DS-Bot's client speaks to.
 *
 * The POST answers every endpoint with the same envelope and always with HTTP 200
 * (`src/host/channel.js:544-552`): the client reads `result.ok`, and a transport-level failure would
 * reach it as a broken network rather than as a refusal it can show. An endpoint this phase has not
 * implemented answers `bot/not-found` with its own name in the message — the honest answer, and the
 * one the harness is expected to show.
 *
 * Every arm is scoped to the person making the request: the roster comes from
 * `AgentProfileStore.list(actor)`, the conversations and the document from that person's own rows.
 * A bot that is not theirs is not found — the same answer `/api/agents` gives, and the same one this
 * file gives for a conversation id that is not in their list.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { transcriptItems } from "./chat";
import { fail, ok, refusal, type BotEnvelope } from "./envelope";
import { applyPreferences } from "./prefs";
import { sendMessage } from "./send";
import type { BotChannelContext, BotChannelDeps } from "./state";
import { liveValue, roster, sessionIdsFor, stateValue } from "./state";

export function createBotChannelRoutes(
  deps: BotChannelDeps,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/", requireUser, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(fail("The request body must be JSON.", "bot/invalid"));
    }
    const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== "string" || endpoint === "") {
      return context.json(fail("Missing endpoint", "bot/invalid"));
    }
    const payload = ((body as { payload?: unknown }).payload ?? {}) as Record<
      string,
      unknown
    >;
    const envelope = await dispatch(
      { deps, actor: context.var.actor, request: context.req.raw },
      endpoint,
      payload,
    );
    return context.json(envelope);
  });

  routes.get("/feed", requireUser, async (context) => {
    // `hello` carries the revision the client starts from (`src/host/feed.js:85-102`), read here so
    // the first event and the first `state` answer agree.
    const document = await deps.document.read(context.var.actor.id);
    return context.newResponse(
      deps.feed.subscribe({ revision: document.revision }),
      200,
      {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    );
  });

  return routes;
}

/** One endpoint's answer, with the catch-all DS-Bot puts around its own switch. */
async function dispatch(
  context: BotChannelContext,
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<BotEnvelope> {
  const { deps, actor } = context;
  try {
    switch (endpoint) {
      case "state": {
        // The live half travels with both answers: a short-circuit tells the client nothing moved,
        // not that nothing is running.
        const value = await stateValue(context, payload);
        return ok({ ...value, ...liveValue([]) });
      }

      case "set-prefs": {
        const document = await deps.document.update(actor.id, (current) => ({
          ...current,
          prefs: applyPreferences(current.prefs, payload),
        }));
        deps.feed.publish("revision", { revision: document.revision });
        return ok(document.prefs);
      }

      case "chat": {
        const botId = typeof payload.botId === "string" ? payload.botId : "";
        const sessions = await sessionIdsFor(
          deps,
          actor,
          roster(actor, await deps.agents.list(actor)),
        );
        const sessionId = sessions.get(botId);
        if (sessionId === undefined) return fail("Unknown Bot", "bot/not-found");
        const messages = await deps.threads.messages(sessionId, actor.id);
        // The cursor is always null: Phase 1 returns the whole conversation rather than a page of
        // it, and a cursor that never pages would be a second thing to get wrong.
        return ok({ sessionId, items: transcriptItems(messages), cursor: null });
      }

      case "send":
        return await sendMessage(context, payload);

      default:
        return fail(`Unknown endpoint ${endpoint}`, "bot/not-found");
    }
  } catch (error) {
    return refusal(error);
  }
}