/**
 * The interface language, remembered across reloads.
 *
 * Same shape and same storage as the theme and sidebar preferences next door: one localStorage
 * key, a parser that only trusts a value this build wrote, and an applier that records the choice.
 *
 * Switching language reloads the page on purpose. Every `t()` call reads the language once, at
 * module load, so a language change is a fresh module graph rather than a re-render of 500 files.
 */

export type Locale = "zh-CN" | "en";

export const LOCALE_STORAGE_KEY = "ccpbot-locale";

/** The languages this build ships. `en` is the source language and needs no dictionary. */
export const LOCALES: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

export const DEFAULT_LOCALE: Locale = "zh-CN";

/**
 * The stored language, or null when nothing trustworthy is stored.
 *
 * An unknown value is dropped rather than guessed at: a dictionary this build does not ship has
 * no strings to show.
 */
export function parseStoredLocale(value: string | null): Locale | null {
  if (value === "zh-CN" || value === "en") {
    return value;
  }
  return null;
}

/**
 * The language to render in.
 *
 * The product ships Chinese first, so an unstored browser gets Chinese regardless of its
 * `navigator.language`: nobody has expressed a preference yet and this build speaks Chinese.
 */
export function resolveLocale(stored: string | null): Locale {
  return parseStoredLocale(stored) ?? DEFAULT_LOCALE;
}

type LocaleEffects = {
  getStoredValue: (key: string) => string | null;
  setStoredValue: (key: string, value: string) => void;
};

/** Reads the effective language without touching the DOM, for the server-side modules and tests. */
export function readLocale(effects: LocaleEffects): Locale {
  return resolveLocale(effects.getStoredValue(LOCALE_STORAGE_KEY));
}

/** Records a language choice. The caller reloads the page afterwards. */
export function applyLocale(locale: Locale, effects: LocaleEffects) {
  effects.setStoredValue(LOCALE_STORAGE_KEY, locale);
}

/** The language this module graph was loaded in. Read once, cached, never re-read. */
let activeLocale: Locale | null = null;

export function currentLocale(): Locale {
  if (activeLocale !== null) {
    return activeLocale;
  }
  let stored: string | null = null;
  try {
    stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Storage can throw in a sandboxed frame or with third-party cookies blocked. Chinese is the
    // documented default, so a read that cannot happen is not an error worth surfacing.
  }
  activeLocale = resolveLocale(stored);
  return activeLocale;
}

/** Test seam: forget the cached language so the next read goes back to storage. */
export function resetLocaleCache() {
  activeLocale = null;
}