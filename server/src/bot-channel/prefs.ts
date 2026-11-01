/*
 * `set-prefs`, validated the way DS-Bot validates it (`src/host/channel.js:100-137`).
 *
 * Same key names, same rule that `null` — or the value that is already the default — deletes the key
 * rather than storing it, and the same messages, because the client shows them verbatim and then
 * reads its own preferences back out of `state`. A preference this file accepted but the client did
 * not expect would show up as a layout nobody chose.
 *
 * `thinking` is the one key that ignores an unknown value instead of refusing: it is a switch, and a
 * third state for a switch is not something a person can act on.
 */

import { invalid } from "./envelope";

const THEME = /^[a-z][\w-]{0,31}$/;
const ACCENT = /^#[0-9a-f]{6}$/i;
const MOTION = new Set(["quiet", "lively"]);

/** Apply whatever the client sent to the stored preferences, returning the whole set. */
export function applyPreferences(
  preferences: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> {
  const body = (payload ?? {}) as Record<string, unknown>;
  const next = { ...preferences };
  const drop = (key: string): void => {
    delete next[key];
  };
  const put = (key: string, value: unknown): void => {
    if (value === null || value === "") drop(key);
    else next[key] = value;
  };

  if (body.theme !== undefined) {
    const value = body.theme;
    if (typeof value !== "string" || !THEME.test(value)) throw invalid("Unknown theme");
    put("theme", value);
  }

  if (body.accent !== undefined) {
    const value = body.accent;
    if (value !== null && value !== "" && (typeof value !== "string" || !ACCENT.test(value))) {
      throw invalid("Accent must be a #rrggbb color");
    }
    put("accent", value);
  }

  if (body.motion !== undefined) {
    const value = body.motion;
    if (value !== null && value !== "normal" && !(typeof value === "string" && MOTION.has(value))) {
      throw invalid("Motion must be quiet, normal or lively");
    }
    put("motion", value === "normal" ? null : value);
  }

  if (body.layout !== undefined) {
    const value = body.layout;
    if (value !== null && value !== "flat" && value !== "bubble") {
      throw invalid("Layout must be bubble or flat");
    }
    put("layout", value === "bubble" ? null : value);
  }

  if (body.width !== undefined) {
    percent(next, "width", body.width, 80, "Width must be a whole percent from 50 to 100");
  }

  if (body.flatWidth !== undefined) {
    percent(
      next,
      "flatWidth",
      body.flatWidth,
      100,
      "Flat text width must be a whole percent from 50 to 100",
    );
  }

  if (body.thinking !== undefined) {
    const value = body.thinking;
    if (value === true) next.thinking = true;
    else if (value === false || value === null) drop("thinking");
  }

  return next;
}

/** One width: the default deletes the key, anything else has to be a whole percent from 50 to 100. */
function percent(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  fallback: number,
  refusal: string,
): void {
  if (value === null || value === fallback) {
    delete target[key];
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 50 || value > 100) {
    throw invalid(refusal);
  }
  target[key] = value;
}