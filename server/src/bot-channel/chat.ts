/*
 * One bot's transcript, in the shape the client reads (`src/host/parts.js:1268-1390`).
 *
 * Two kinds, not five: DS-Bot's `answer`, `event` and `view` items come from parts this deployment
 * does not have (questions, tool events, rendered views), and inventing one would put a card in the
 * transcript that no agent produced. A Phase-1 conversation is what CCP-Bot actually stores: what
 * the person said and what the agent answered.
 *
 * `time` is the gap this file cannot close on its own. The client's clock separators require
 * `Number.isFinite(item.time)` (`src/client/cells.js:518-520`) and `time` is epoch milliseconds
 * there, but `ThreadStore.messages()` returns the stored AG-UI payloads, which carry no timestamp —
 * the column that has one (`thread_messages.created_at`) is not in the returned shape. So items are
 * emitted without a time and the transcript renders with its separators missing, rather than with a
 * time this process made up. Closing it is one line in `threads/store.ts` (return `createdAt` beside
 * the payload); it is outside this task's write scope, so it is reported instead of taken.
 */

export type BotChatItem = {
  kind: "bot" | "user";
  text: string;
  time?: number;
};

/** The text of an AG-UI message, whether it arrived as a string or as parts. */
function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = (part as { text?: unknown })?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/**
 * The transcript items for a conversation.
 *
 * Roles other than the person and the agent are dropped rather than rendered as a third kind: a
 * system message is not something a reader of this transcript said.
 */
export function transcriptItems(
  messages: Record<string, unknown>[],
): BotChatItem[] {
  const items: BotChatItem[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(message);
    if (text === "") continue;
    items.push({ kind: role === "user" ? "user" : "bot", text });
  }
  return items;
}