/*
 * The SSE half of the bot channel: `GET /api/bot/feed`.
 *
 * Event names, framing and the keepalive line are DS-Bot's (`src/host/feed.js:9-102`): `hello` as
 * soon as a reader attaches, `revision` when the stored document moved, `live` when the team's state
 * did, `message` once per transcript item, and `stream` for the three moments of one answer
 * (start / text / end). The client switches on those five names, so a sixth would arrive as an
 * unhandled event and a rename would arrive as silence.
 *
 * Two properties are copied rather than chosen: a reader that falls more than `MAX_QUEUED` events
 * behind is dropped instead of growing this process without limit, and a comment line keeps an idle
 * connection alive through whatever sits between us and the window (`src/host/feed.js:51-77`).
 *
 * How often that comment is sent is the one place this file departs from DS-Bot's twenty seconds,
 * and it departs downward on purpose: `Bun.serve` closes a connection that has sent nothing for ten
 * seconds (its default `idleTimeout` — the same limit `delivery/opentag.ts:400` and
 * `browser/routes.ts:125` are already written to beat), so a twenty-second heartbeat would never
 * arrive: the window would see the feed end rather than a line it ignores. The frame is DS-Bot's;
 * only the cadence is this deployment's.
 */

export type BotFeedEvent = "hello" | "revision" | "live" | "message" | "stream";

export const KEEPALIVE_MS = 8_000;
export const LIVE_DELAY_MS = 150;
export const MAX_QUEUED = 512;

const encoder = new TextEncoder();

/** One event, framed the way an EventSource reads it. */
export function frame(event: BotFeedEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A comment line, which an EventSource ignores and a proxy counts as traffic. */
export const KEEPALIVE = ": keepalive\n\n";

export type BotFeed = {
  /** Send one event to every reader now. */
  publish(event: BotFeedEvent, data: unknown): void;
  /** Send `live` once, however many calls arrive in the next `LIVE_DELAY_MS`. */
  live(data: unknown): void;
  /** Attach a reader, starting with the `hello` payload it was given. */
  subscribe(hello: unknown): ReadableStream<Uint8Array>;
  subscribers(): number;
  /** Stop the keepalive timer. Called when the server goes down, not per request. */
  stop(): void;
};

type Connection = {
  send: (text: string) => void;
  behind: () => boolean;
  close: () => void;
};

export function createBotFeed(
  options: {
    keepaliveMs?: number;
    liveDelayMs?: number;
    maxQueued?: number;
  } = {},
): BotFeed {
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const liveDelayMs = options.liveDelayMs ?? LIVE_DELAY_MS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED;

  const connections = new Set<Connection>();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let pending: unknown;

  const stopKeepalive = (): void => {
    if (keepalive === undefined || connections.size > 0) return;
    clearInterval(keepalive);
    keepalive = undefined;
  };

  const sendLive = (): void => {
    scheduled = undefined;
    const data = pending;
    pending = undefined;
    send("live", data);
  };

  const send = (event: BotFeedEvent, data: unknown): void => {
    const text = frame(event, data);
    for (const connection of [...connections]) {
      // Dropped rather than buffered: a window that is not reading is a window that will re-attach
      // and read `state` again, and this process has no business holding its backlog.
      if (connection.behind()) {
        connections.delete(connection);
        connection.close();
        continue;
      }
      connection.send(text);
    }
  };

  return {
    publish(event, data) {
      send(event, data);
    },
    live(data) {
      pending = data;
      if (scheduled !== undefined) return;
      scheduled = setTimeout(sendLive, liveDelayMs);
    },
    subscribe(hello) {
      let current: Connection | undefined;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (text: string): void => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              // The reader went away between the check and the write; `cancel` will do the rest.
            }
          };
          current = {
            send: (text) => write(text),
            behind: () => {
              const size = controller.desiredSize;
              return size !== null && size < -maxQueued;
            },
            close: () => {
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            },
          };
          connections.add(current);
          write(frame("hello", hello));
          if (keepalive === undefined) {
            keepalive = setInterval(() => {
              for (const connection of [...connections]) connection.send(KEEPALIVE);
            }, keepaliveMs);
          }
        },
        cancel() {
          if (current !== undefined) connections.delete(current);
          stopKeepalive();
        },
      });
    },
    subscribers: () => connections.size,
    stop() {
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = undefined;
      if (keepalive !== undefined) clearInterval(keepalive);
      keepalive = undefined;
      for (const connection of [...connections]) connection.close();
      connections.clear();
    },
  };
}