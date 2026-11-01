/*
 * The envelope DS-Bot's host answers every endpoint with, and the classifier that decides which code
 * a thrown error becomes.
 *
 * Copied from DS-Bot's own host (`src/host/channel.js:14-34`) rather than reinterpreted: the client
 * reads `result.ok`, then `result.error.code`, and its refusals list is a fixed set of `bot/…` codes
 * (`src/client/api.js`), so a code invented here would surface as an internal error and a details
 * panel. `bot/` codes pass through untouched; a programming mistake is `bot/internal`; everything
 * else is `bot/refused`.
 */

export type BotEnvelope =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { code: string; message: string; details: Record<string, never> };
    };

/** Answer, with whatever the endpoint produced. */
export function ok(value: unknown): BotEnvelope {
  return { ok: true, value };
}

/** Refuse, in the shape the client expects to read a code out of. */
export function fail(message: string, code = "bot/error"): BotEnvelope {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * A caller's mistake — a bad preference, nothing to send — as opposed to a refusal.
 *
 * An Error with a code rather than a class, matching the source: the classifier below reads the code
 * off whatever was thrown, and a class hierarchy would be a second way to express the same thing.
 */
export function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "bot/invalid" });
}

/** True for the errors this file calls the deployment's own fault rather than the caller's. */
function isInternal(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof SyntaxError ||
    (typeof (error as { code?: unknown })?.code === "string" &&
      /^E[A-Z_]+$/.test((error as { code: string }).code))
  );
}

/** Which code an error becomes, without losing a code that already names one of ours. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code.startsWith("bot/")) return code;
  return isInternal(error) ? "bot/internal" : "bot/refused";
}

/**
 * The envelope for a thrown error, with the message the endpoint author wrote.
 *
 * `details` stays empty on purpose: DS-Bot's internal branch is what puts the stack somewhere a
 * person can read (Settings → Feedback), and this deployment has no equivalent to point at yet, so
 * inventing one here would be a promise this phase does not keep.
 */
export function refusal(error: unknown): BotEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  return fail(message, errorCode(error));
}