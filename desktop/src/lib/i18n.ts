/**
 * Which language the desktop shell speaks.
 *
 * The shell is a single-window application, so there is no place to switch language inside it: the
 * choice is read once, from the same storage key the interface served by the stack uses, and the
 * shell therefore follows whatever the person picked there. Chinese is the default, because this
 * build is for a Chinese-speaking person first and the upstream shell was English.
 *
 * A test pins the language with `globalThis.__ccpbotLocale` (see the repository's `bunfig.toml`
 * preload), so every assertion in the suites stays written in the language it was written in.
 */

import { ZH_CN } from "./i18n-messages";

export type Locale = "zh-CN" | "en";

export const LOCALE_STORAGE_KEY = "ccpbot-locale";
export const LOCALE_OVERRIDE_KEY = "__ccpbotLocale";
export const LOCALES: Locale[] = ["zh-CN", "en"];
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** `null` for anything that is not one of the two languages this build knows. */
export function parseStoredLocale(value: string | null | undefined): Locale | null {
  return value === "zh-CN" || value === "en" ? value : null;
}

/** The language a test pinned, if any. Never read in the running application. */
function readOverride(): Locale | null {
  const pinned: unknown = (globalThis as Record<string, unknown>)[LOCALE_OVERRIDE_KEY];
  return typeof pinned === "string" ? parseStoredLocale(pinned) : null;
}

let activeLocale: Locale | null = null;

/**
 * The language to render in.
 *
 * Cached after the first read: the value cannot change while a window is open (nothing in this
 * application writes the storage key), and the answer is wanted on every string.
 */
export function currentLocale(): Locale {
  if (activeLocale !== null) {
    return activeLocale;
  }
  const pinned = readOverride();
  if (pinned !== null) {
    activeLocale = pinned;
    return pinned;
  }
  const stored =
    typeof localStorage === "undefined" ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
  activeLocale = parseStoredLocale(stored) ?? DEFAULT_LOCALE;
  return activeLocale;
}

/** Kept for tests that want to read the storage again after changing it. */
export function resetLocaleCache(): void {
  activeLocale = null;
}

/**
 * The shell's own words, in the language the window is speaking.
 *
 * Keyed by the English sentence, the same arrangement the interface uses: a string that has not been
 * translated yet still renders, so an incomplete catalogue shows English in one place instead of
 * nothing anywhere.
 */
export function t(source: string): string {
  if (currentLocale() !== "zh-CN") {
    return source;
  }
  const translated = ZH_CN[source];
  return translated !== undefined && translated.trim() !== "" ? translated : source;
}

/** `t`, with `{name}` placeholders filled in from `vars`. */
export function tf(source: string, vars: Record<string, string | number>): string {
  return t(source).replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}