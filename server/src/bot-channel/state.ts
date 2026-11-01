/*
 * `state`: the team snapshot, and the `live()` half that travels with it.
 *
 * Everything here comes out of this deployment's own tables — the roster is
 * `AgentProfileStore.list(actor)` and a bot's `sessionId` is that bot's most recent conversation in
 * `ThreadStore` — so a bot in the DS-Bot window is a bot CCP-Bot actually runs, under the same
 * ownership rules as `/api/agents` and `/api/threads`. Nothing is a copy of DS-Bot's `state.json`
 * that could drift away from the deployment it describes.
 *
 * Keys this phase does not produce are left out rather than sent empty: `rooms`, `exchangeTurns`,
 * `questions`, `views`, `agents`, `secrets`, `capabilities`, `models` and `defaultModel` all belong
 * to parts of DS-Bot that have no CCP-Bot counterpart yet, and the client treats an absent key as
 * "nothing here" while an empty object it will happily render as a section with no rows. The
 * harness's job is to say which of those the window insists on; see `docs/ds-bot-phase1.md`.
 *
 * `live()` is deliberately thin: it reports the one thing this phase can tell the truth about, that
 * nothing is running unless a `send` is in flight. Run tracking is a later arm.
 */

import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AgentProfileStore } from "../agents/profile-store";
import type { ThreadStore } from "../threads/store";
import type { BotChannelDocument } from "./document";
import type { BotFeed } from "./feed";

export type BotChannelDeps = {
  document: {
    read(userId: string): Promise<BotChannelDocument>;
    update(
      userId: string,
      mutate: (document: BotChannelDocument) => BotChannelDocument,
    ): Promise<BotChannelDocument>;
  };
  agents: AgentProfileStore;
  threads: ThreadStore;
  /**
   * One turn, driven the way the window drives it.
   *
   * The copilot handler itself — the same object `app.ts` mounts at `/`
   * (`app.route("/", copilotHandler)`), which is why the request below carries the caller's own
   * headers and cookie: the runtime resolves the person from the request exactly as it does for a
   * real browser call, and a synthetic identity here would be a second authentication system.
   */
  run: (request: Request) => Promise<Response>;
  feed: BotFeed;
  /** A conversation id for a bot that has not had one yet. */
  newThreadId: () => string;
};

export type BotChannelContext = {
  deps: BotChannelDeps;
  actor: AgentActor;
  /** The request the client made, whose headers are forwarded to a run. */
  request: Request;
};

/** What DS-Bot calls a bot: enough of a coworker for the window's roster and pickers. */
function botValue(profile: AgentProfile, sessionId: string): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    role: profile.title,
    instructions: profile.roleDescription,
    avatar: profile.avatarSeed,
    sessionId,
  };
}

/**
 * Which conversation each bot is on, creating one for a bot that has never spoken.
 *
 * DS-Bot's `bootstrap()` (`src/host/channel.js:139-152`) does the same thing for its own chats: a
 * bot with no conversation gets one when the snapshot is built, so the window has somewhere to type.
 * Here that is a real row in `threads`, owned by the person asking, created through the same store
 * `/api/threads` reads.
 */
export async function sessionIdsFor(
  deps: BotChannelDeps,
  actor: AgentActor,
  profiles: AgentProfile[],
): Promise<Map<string, string>> {
  const summaries = await deps.threads.list(actor.id);
  const sessions = new Map<string, string>();
  for (const summary of summaries) {
    if (summary.agentId === null) continue;
    if (!sessions.has(summary.agentId)) sessions.set(summary.agentId, summary.id);
  }
  for (const profile of profiles) {
    if (sessions.has(profile.id)) continue;
    const threadId = deps.newThreadId();
    await deps.threads.record({
      threadId,
      ownerUserId: actor.id,
      agentId: profile.id,
      messages: [],
    });
    sessions.set(profile.id, threadId);
  }
  return sessions;
}

/**
 * The Bots DS-Bot's window shows this person.
 *
 * `AgentProfileStore.list(actor)` answers a wider set for an administrator, on purpose: `/api/agents`
 * is where a deployment is managed, and an administrator manages all of it. The team pane is not
 * that screen — a Bot belonging to somebody else would put its name and title in front of a person
 * who cannot use it, and this channel exists to serve one person's own Bots. So the roster is the
 * person's own, the ones an administrator assigned them, and the deployment's own.
 */
export function roster(
  actor: AgentActor,
  profiles: AgentProfile[],
): AgentProfile[] {
  return profiles.filter(
    (profile) =>
      profile.ownerUserId === actor.id ||
      profile.systemOwned ||
      profile.assignedToMe === true,
  );
}

/** The `live()` half, which every snapshot and every `live` feed event carries. */
export function liveValue(running: readonly string[]): Record<string, unknown> {
  return {
    work: {
      bots: [...running],
      rooms: [],
      approvals: [],
      waiting: [],
      turns: [],
      steered: [],
    },
  };
}

/** The snapshot the client keeps, or the short-circuit answer when nothing moved. */
export async function stateValue(
  context: BotChannelContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | { revision: number; unchanged: true }> {
  const { deps, actor } = context;
  const document = await deps.document.read(actor.id);
  const since = payload.since;
  if (typeof since === "number" && since === document.revision) {
    /*
     * DS-Bot answers a `state` whose revision it already has with just the live half
     * (`src/host/channel.js:146-152`). The `models` half of that condition is dropped here: this
     * deployment has no managed model catalog for the client to compare against, so a `models` key
     * it sends back is not something that can move.
     */
    return { revision: document.revision, unchanged: true };
  }
  const profiles = roster(actor, await deps.agents.list(actor));
  const sessions = await sessionIdsFor(deps, actor, profiles);
  const mainBotIds = document.mainBotIds.filter((id) => sessions.has(id));
  return {
    revision: document.revision,
    /*
     * DS-Bot's workspace identity, for a deployment with one workspace per person.
     *
     * Prefixed rather than a bare user id: it names this deployment's document for this person, and
     * two deployments that both name a bare id would look like the same workspace to a client that
     * stores one.
     */
    workspaceId: `ccpbot:${actor.id}`,
    mainBotIds,
    mainBotId: mainBotIds[0] ?? null,
    bots: profiles.map((profile) =>
      botValue(profile, sessions.get(profile.id) as string),
    ),
    /*
     * The collections this deployment has nothing to put in, sent as the empty shape rather than
     * left out. DS-Bot's client reads two of them without a guard — `src/client/sources.js:28-32`
     * iterates `value.bots` and `value.rooms` as arrays — and its own empty roster is this same
     * shape (`:19`), so an absent key would reach the window as a TypeError instead of "there are
     * none". Group chats, learned capabilities, secret requests, the model catalogue and the turn,
     * card and side-chat indexes are each a later phase's arm; none of them is filled with a
     * stand-in value here.
     */
    rooms: [],
    agents: [],
    exchangeTurns: {},
    questions: {},
    btwCards: {},
    sideChats: {},
    secrets: [],
    capabilities: [],
    capabilityStatuses: {},
    secretRequests: {},
    models: [],
    defaultModel: null,
    modelsKey: null,
    prefs: document.prefs,
    // There is no read-only switch in this deployment; the client's banner stays off because this
    // is not a read-only host, not because the flag was defaulted.
    readOnly: false,
  };
}