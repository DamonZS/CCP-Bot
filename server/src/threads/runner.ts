import type { BaseEvent } from "@ag-ui/client";
import {
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
  ThreadAccessDeniedError,
  ɵresolveThreadOwner,
  ɵSERVER_THREAD_OWNER,
} from "@copilotkit/runtime/v2";
import { defer, from, Observable, switchMap } from "rxjs";
import type { ThreadStore } from "./store";

/**
 * The runner a deployment with no CopilotKit Intelligence runs on: the SDK's in-memory one, with the
 * conversation written to this deployment's own tables as each run ends.
 *
 * WHY THIS AND NOT A RUNNER OF OUR OWN. The SDK ships two things: `AgentRunner`, an abstract class
 * whose implementation is a whole run engine (start, events, stop, event compaction), and
 * `LocalThreadEndpointRunner`, which is only an *interface* extending it
 * (`node_modules/@copilotkit/runtime/dist/v2/runtime/runner/agent-runner.d.mts:114-123`) with
 * memories of a thread read **synchronously** (`getThreadMessages(threadId, scope?): Message[]`).
 * Postgres cannot be read synchronously, so that interface cannot be backed by the database, and
 * re-implementing the engine to gain nothing but a different store is the wrong trade. What is
 * needed is exactly what `InMemoryAgentRunner` does — run the agent, hold the thread while the run
 * lives — plus one thing it does not do: keep the messages after the process ends. Hence extending
 * it, and persisting on the completion of each run.
 *
 * WHERE THE OWNER IN THE TABLES DECIDES. The runtime asks `isThreadAccessible` before every run
 * (`node_modules/@copilotkit/runtime/dist/v2/handlers/handle-run.mjs:37`), and the abstract class
 * allows that answer to be a promise — but `InMemoryAgentRunner` declares it synchronous, and a
 * subclass may not widen it (`in-memory.d.mts:344`). Postgres cannot answer synchronously either, so
 * the durable answer is given where an await is allowed: at the top of `run()`, before the SDK's own
 * runner is entered. A run on somebody else's conversation is refused there instead of being
 * reported as a thread that does not exist, which is the one thing this must not get wrong.
 *
 * WHAT THIS DOES NOT PROMISE, and callers must not assume: the SDK's own thread endpoints
 * (`listThreads`, `getThreadMessages`, `getThreadEvents`, `getThreadState` on the runner, behind
 * `supportsLocalThreadEndpoints`) stay process-local. They answer about threads this process has
 * run. Across a restart, a conversation is read from `ThreadStore` — which is what `history()` and
 * `/api/threads` use.
 */
export class LocalThreadRunner extends InMemoryAgentRunner {
  private readonly store: ThreadStore;
  private saidNoOwner = false;

  constructor(options: { store: ThreadStore }) {
    super();
    this.store = options.store;
  }

  /**
   * The run itself, behind the ownership check, with the write held between the last event and
   * completion.
   *
   * The SDK fills its thread snapshot while the run streams and finishes it just before the
   * observable completes, so a subscriber told "complete" would otherwise hear it before the
   * conversation reached the database — and a process that exits on that signal would lose it.
   * Waiting for the write is also what lets a test read the messages back the moment the run's own
   * response has arrived, instead of sleeping and hoping.
   */
  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    return defer(() => from(this.mayRun(request))).pipe(
      switchMap(() => this.streaming(request)),
    );
  }

  /** Refuses a conversation that belongs to somebody else, as the SDK's own denial is refused. */
  private async mayRun(request: AgentRunnerRunRequest): Promise<void> {
    const ownerUserId = ɵresolveThreadOwner(request.ownerId);
    const owner = await this.store.ownerOf(request.threadId);
    if (owner !== undefined && owner !== ownerUserId) {
      throw new ThreadAccessDeniedError();
    }
  }

  private streaming(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const source = super.run(request);
    return new Observable<BaseEvent>((subscriber) => {
      const subscription = source.subscribe({
        next: (event) => {
          subscriber.next(event);
        },
        error: (failure: unknown) => {
          subscriber.error(failure);
        },
        complete: () => {
          void this.keep(request).then(
            () => {
              subscriber.complete();
            },
            (failure: unknown) => {
              this.failed(request.threadId, failure);
              // The conversation ran; only keeping it failed. Refusing the run now would take a
              // working answer away from somebody because a write went wrong.
              subscriber.complete();
            },
          );
        },
      });
      return () => {
        subscription.unsubscribe();
      };
    });
  }

  private async keep(request: AgentRunnerRunRequest): Promise<void> {
    const ownerUserId = ɵresolveThreadOwner(request.ownerId);
    if (ownerUserId === ɵSERVER_THREAD_OWNER) {
      if (!this.saidNoOwner) {
        this.saidNoOwner = true;
        console.warn(
          JSON.stringify({
            type: "thread-not-kept",
            reason:
              "A run reached the runner with no user on it, and a conversation is only written down for the person it belongs to, so this one is held in memory alone.",
          }),
        );
      }
      return;
    }
    // What the run held: plain JSON, put there by the SDK's own messages, and read back as the same
    // objects by `history()`.
    const messages = super.getThreadMessages(request.threadId, {
      ownerId: ownerUserId,
    }) as unknown as Record<string, unknown>[];
    await this.store.record({
      threadId: request.threadId,
      ownerUserId,
      agentId: request.agent.agentId ?? null,
      messages,
    });
  }

  private failed(threadId: string, failure: unknown): void {
    console.warn(
      JSON.stringify({
        type: "thread-keep-failed",
        threadId,
        reason: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  }
}