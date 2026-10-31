import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

/**
 * A conversation of this deployment's own.
 *
 * Until this table existed, a thread was a fact about CopilotKit Intelligence: the platform issued
 * the id, kept the messages, and answered every question about them. A deployment with no connection
 * (`mode: "sse"`; see `RuntimeCapabilities` in `src/config.ts`) had nowhere to keep one, so a
 * conversation ended when the process did. A row here answers "whose conversation is this, and is it
 * still there" without asking anybody.
 *
 * `agent_id` is the Bot the thread was last run with, deliberately NOT a foreign key: a Bot can be
 * retired, and the conversation that ran with it stays readable.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("threads_owner_updated_idx").on(table.ownerUserId, table.updatedAt),
  ],
);

/**
 * Every message a conversation has, in the order the agent held them.
 *
 * The whole message is stored rather than a row per field. An AG-UI message carries tool calls, a
 * name, and an id that a later run needs back verbatim; a table that kept only role and rendered
 * text would answer a read with something the agent never said. `role` is lifted out of the payload
 * so the table can be read by a person.
 *
 * The key is (thread, position) because a write replaces a conversation's rows with the snapshot the
 * run ended on: a restart that reads the same conversation back writes the same rows rather than
 * appending a second copy of it, and a message that carries no id of its own still has a place.
 * `position` is also what a read orders by.
 */
export const threadMessages = pgTable(
  "thread_messages",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    role: text("role").notNull(),
    message: jsonb("message").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.position] })],
);