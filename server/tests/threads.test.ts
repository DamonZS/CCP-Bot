import { describe, expect, spyOn, test } from "bun:test";
import { ThreadAccessDeniedError } from "@copilotkit/runtime/v2";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { LocalThreadRunner } from "../src/threads/runner";
import { createStoredThreadReader, type ThreadStore } from "../src/threads/store";
import { standaloneEnvironment } from "./support/environment";

/**
 * The parts of "this deployment keeps its own conversations" that need no database.
 *
 * That the record really outlives the process is proved against a real PostgreSQL — a run through
 * the runtime, then a second instance reading it — in threads.integration.test.ts. What is here is
 * the wiring around that record: what a read answers when no store was handed to the mount, which
 * conversation a store says exists, and that a run on somebody else's conversation is refused
 * before the Bot is ever reached.
 */

const BOT = "threads-test-bot";
const USER = "threads-test-user";

function stubStore(overrides: Partial<ThreadStore> = {}): ThreadStore {
  return {
    known: async () => false,
    ownerOf: async () => undefined,
    list: async () => [],
    messages: async () => [],
    record: async () => {},
    ...overrides,
  };
}

/**
 * A mount with no Bot to resolve: Bots are loaded on each request (`createRequestAgents`), and
 * nothing in this file sends one.
 */
function mount(threads?: ThreadStore) {
  return mountCopilotRuntime(
    loadConfig(standaloneEnvironment()),
    {
      resolveAgentsForActor: async () => ({}),
      resolveAgentForActor: async () => {
        throw new Error(`no Bot is loaded in this file (${BOT})`);
      },
    },
    async () => ({ id: USER, name: "Threads test" }),
    async () => ({ id: USER, role: "admin" }),
    threads ? { threads } : {},
  );
}

describe("reading a conversation this deployment has no platform for", () => {
  test("answers empty and says so once, rather than looking like a conversation nobody wrote", async () => {
    const warned: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(
      (...data: unknown[]) => {
        warned.push(String(data[0]));
      },
    );
    let first: unknown;
    let second: unknown;
    try {
      const mounted = mount();
      first = await mounted.history({ threadId: "t", actorId: USER });
      second = await mounted.history({ threadId: "t", actorId: USER });
    } finally {
      warn.mockRestore();
    }

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    const said = warned.filter((line) =>
      line.includes("intelligence-absent-history"),
    );
    expect(said).toHaveLength(1);
  });

  test("hands back what the store kept", async () => {
    const kept = [
      { id: "m-1", role: "user", content: "remember this" },
      { id: "m-2", role: "assistant", content: "kept" },
    ];
    const mounted = mount(stubStore({ messages: async () => kept }));

    expect(
      await mounted.history({ threadId: "t", actorId: USER }),
    ).toEqual(kept);
  });
});

describe("a conversation belongs to one person", () => {
  test("the reader answers for what the store holds, and for nobody else", async () => {
    const known = createStoredThreadReader(
      stubStore({ known: async () => true }),
    );
    const unknown = createStoredThreadReader(stubStore());

    expect(await known("t", USER)).toBe("known");
    expect(await unknown("t", USER)).toBe("unknown");
  });

  test("a run on somebody else's conversation is refused", async () => {
    const runner = new LocalThreadRunner({
      store: stubStore({ ownerOf: async () => "somebody-else" }),
    });

    const failure = await new Promise<unknown>((resolve) => {
      runner
        .run({
          threadId: "t",
          agent: {} as never,
          input: {} as never,
          ownerId: USER,
        })
        .subscribe({ error: resolve });
    });

    expect(failure).toBeInstanceOf(ThreadAccessDeniedError);
  });
});