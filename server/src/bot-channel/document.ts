/*
 * The one document this phase stores, and where it lives.
 *
 * `users.preferences` under a `dsBot` key — no new table, because this is one document per person
 * and that column is already that: a jsonb bag per user which merges in Postgres
 * (`user-preferences.ts:42-54`), so a key written here survives every other preference write and
 * vice versa. The column is typed as CCP-Bot's own preferences, so reading a sibling key needs one
 * cast; it is kept to this file so nothing else deals in an untyped bag.
 *
 * The document is deliberately small: what DS-Bot keeps in `state.json` is a whole workspace
 * (`src/host/store.js:22`), and this phase implements five arms of it. `revision` is the version the
 * client compares against to decide whether a `state` read changed anything, which is the
 * short-circuit in `src/host/channel.js:146-152`.
 */

import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";

export type BotChannelDocument = {
  version: 1;
  /** Which bots are the person's main ones, in the order the team pane shows them. */
  mainBotIds: string[];
  /** The DS-Bot preferences the client sends back through `set-prefs`. */
  prefs: Record<string, unknown>;
  /** Bumped by every write; the client's `state` short-circuit reads it. */
  revision: number;
};

export const EMPTY_DOCUMENT: BotChannelDocument = {
  version: 1,
  mainBotIds: [],
  prefs: {},
  revision: 0,
};

const KEY = "dsBot";

/** The stored document, or the empty one when this person has never written any. */
export async function readDocument(
  database: Database,
  userId: string,
): Promise<BotChannelDocument> {
  const [row] = await database
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error("User preferences could not be found.");
  return documentIn(row.preferences);
}

/**
 * Change the document and store it, with the read and the write inside one transaction.
 *
 * The row is selected `for update` first: two requests that each read-modify-write the document
 * (dropping a bot while a preference saves) would otherwise lose one of the two writes, and the
 * merge in SQL is not enough on its own because the mutation here reads what it is about to change.
 */
export async function updateDocument(
  database: Database,
  userId: string,
  mutate: (document: BotChannelDocument) => BotChannelDocument,
): Promise<BotChannelDocument> {
  return await database.transaction(async (transaction) => {
    const [row] = await transaction
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!row) throw new Error("User preferences could not be found.");
    const before = documentIn(row.preferences);
    const next: BotChannelDocument = {
      ...mutate(before),
      version: 1,
      revision: before.revision + 1,
    };
    const patch = { [KEY]: next };
    const [updated] = await transaction
      .update(users)
      .set({
        // `coalesce` because a person who has never saved a preference has a NULL column, and
        // `NULL || anything` in jsonb is NULL rather than the anything. The patch is bound as an
        // object, not as `JSON.stringify`: the driver JSON-encodes a string bound for a jsonb
        // parameter, which `||` would then concatenate as a scalar and store as an array.
        preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || ${patch}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ preferences: users.preferences });
    if (!updated) throw new Error("User preferences could not be saved.");
    return documentIn(updated.preferences);
  });
}

/**
 * The document inside a preferences row, as far as it can be trusted.
 *
 * A row written by an older or newer build is still this person's preferences: the keys this file
 * does not know are left where they are, and a value of the wrong shape is replaced by the empty
 * document rather than half-read.
 */
function documentIn(preferences: unknown): BotChannelDocument {
  const stored = (preferences as Record<string, unknown> | null)?.[KEY];
  if (typeof stored !== "object" || stored === null) return EMPTY_DOCUMENT;
  const candidate = stored as Partial<BotChannelDocument>;
  return {
    version: 1,
    mainBotIds: Array.isArray(candidate.mainBotIds)
      ? candidate.mainBotIds.filter((id): id is string => typeof id === "string")
      : [],
    prefs:
      typeof candidate.prefs === "object" && candidate.prefs !== null
        ? candidate.prefs
        : {},
    revision:
      typeof candidate.revision === "number" && Number.isFinite(candidate.revision)
        ? candidate.revision
        : 0,
  };
}