import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { ThreadReader } from "../channels/thread-routes";
import type { Database } from "../db/client";
import { threadMessages, threads } from "../db/schema";

/**
 * One conversation, as this deployment remembers it.
 *
 * A deployment with no CopilotKit Intelligence (`mode: "sse"`; see `RuntimeCapabilities` in
 * `src/config.ts`) has no platform to ask about a thread, so everything a read needs has to be here:
 * who the conversation belongs to, whether it still exists, and what was said in it. The store is the
 * read side of that promise — the runner writes it, `history()` and `/api/threads` read it.
 *
 * Ownership is part of every read rather than a check a caller remembers to make: a method that is
 * handed a thread id and a user id answers only what that user could see.
 */
export type ThreadSummary = {
  id: string;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ThreadStore = {
  /** Whether this person has a conversation with this id. */
  known(threadId: string, ownerUserId: string): Promise<boolean>;
  /** Who a conversation belongs to, or `undefined` when this deployment has never seen it. */
  ownerOf(threadId: string): Promise<string | undefined>;
  /** This person's conversations, the most recently used first. */
  list(ownerUserId: string): Promise<ThreadSummary[]>;
  /** A conversation's messages, in the order the agent held them. Empty when it is unknown. */
  messages(
    threadId: string,
    ownerUserId: string,
  ): Promise<Record<string, unknown>[]>;
  /** Replace what is kept for a conversation with the snapshot a run ended on. */
  record(input: {
    threadId: string;
    ownerUserId: string;
    agentId: string | null;
    messages: Record<string, unknown>[];
  }): Promise<void>;
};

/**
 * A list is a screenful. A person with more conversations than this reads the newest ones, and the
 * alternative — paging a sidebar nobody has paged — is a shape this deployment has not needed.
 */
const LIST_LIMIT = 200;

/** `role` is lifted out of the payload for a person reading the table; not every payload has one. */
function roleOf(message: Record<string, unknown>): string {
  const role = message.role;
  return typeof role === "string" && role.length > 0 ? role : "unknown";
}

export function createThreadStore(database: Database): ThreadStore {
  return {
    async known(threadId, ownerUserId) {
      const rows = await database
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.ownerUserId, ownerUserId)))
        .limit(1);
      return rows.length > 0;
    },

    async ownerOf(threadId) {
      const rows = await database
        .select({ ownerUserId: threads.ownerUserId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      return rows[0]?.ownerUserId;
    },

    async list(ownerUserId) {
      return database
        .select({
          id: threads.id,
          agentId: threads.agentId,
          createdAt: threads.createdAt,
          updatedAt: threads.updatedAt,
        })
        .from(threads)
        .where(eq(threads.ownerUserId, ownerUserId))
        .orderBy(desc(threads.updatedAt))
        .limit(LIST_LIMIT);
    },

    async messages(threadId, ownerUserId) {
      const rows = await database
        .select({ message: threadMessages.message })
        .from(threadMessages)
        .innerJoin(threads, eq(threads.id, threadMessages.threadId))
        .where(
          and(
            eq(threadMessages.threadId, threadId),
            eq(threads.ownerUserId, ownerUserId),
          ),
        )
        .orderBy(asc(threadMessages.position));
      return rows.map((row) => row.message);
    },

    async record(input) {
      const { threadId, ownerUserId, agentId, messages } = input;
      await database.transaction(async (transaction) => {
        await transaction
          .insert(threads)
          .values({ id: threadId, ownerUserId, agentId })
          .onConflictDoUpdate({
            target: threads.id,
            set: { agentId, updatedAt: new Date() },
          });
        // One run per thread, so the snapshot is the whole truth: rows past its end are gone, and
        // the rest are written in place rather than appended beside an older copy of themselves.
        await transaction
          .delete(threadMessages)
          .where(
            and(
              eq(threadMessages.threadId, threadId),
              gte(threadMessages.position, messages.length),
            ),
          );
        for (const [position, message] of messages.entries()) {
          await transaction
            .insert(threadMessages)
            .values({ threadId, position, role: roleOf(message), message })
            .onConflictDoUpdate({
              target: [threadMessages.threadId, threadMessages.position],
              set: { role: roleOf(message), message },
            });
        }
      });
    },
  };
}

/**
 * Whether a conversation is still here, in the shape `/api/threads` asks the question
 * (`ThreadReader` in `channels/thread-routes.ts`).
 *
 * The same question a platform answers about its own threads, answered from this deployment's table:
 * a person's own conversation is "known", and anything else — somebody else's, an id nobody wrote, an
 * id from a deployment this database never saw — is "unknown".
 */
export function createStoredThreadReader(store: ThreadStore): ThreadReader {
  return async (threadId, userId) =>
    (await store.known(threadId, userId)) ? "known" : "unknown";
}