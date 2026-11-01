/*
 * The bot channel, assembled from what `index.ts` already holds.
 *
 * One factory rather than a module-level singleton: the deployment's database, its roster store, its
 * conversation store and its copilot handler are all built in `index.ts`, and passing them here keeps
 * this module free of the boot order. `app.ts` mounts the routes only when this object is present, so
 * a caller that passes nothing gets no `/api/bot` rather than a half-wired one.
 */

import { randomUUID } from "node:crypto";
import type { AgentProfileStore } from "../agents/profile-store";
import type { Database } from "../db/client";
import type { ThreadStore } from "../threads/store";
import { readDocument, updateDocument } from "./document";
import { createBotFeed } from "./feed";
import type { BotChannelDeps } from "./state";

export { createBotChannelRoutes } from "./routes";
export type { BotChannelDeps } from "./state";

export function createBotChannel(deps: {
  database: Database;
  agents: AgentProfileStore;
  threads: ThreadStore;
  /**
   * The copilot handler, taken from `mountCopilotRuntime`'s return.
   *
   * The same object `app.ts` mounts at `/`, which is what makes the request `send` builds reach the
   * agent under the caller's own identity rather than a second one invented here.
   */
  handler: { fetch: (request: Request) => Response | Promise<Response> };
}): BotChannelDeps {
  return {
    document: {
      read: (userId) => readDocument(deps.database, userId),
      update: (userId, mutate) => updateDocument(deps.database, userId, mutate),
    },
    agents: deps.agents,
    threads: deps.threads,
    run: async (request) => await deps.handler.fetch(request),
    feed: createBotFeed(),
    newThreadId: () => randomUUID(),
  };
}