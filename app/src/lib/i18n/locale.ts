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

/**
 * The languages this build ships, as source strings.
 *
 * The labels are deliberately not put through `t()` here: doing so would import this module's own
 * barrel from inside it, and `t()` reads `currentLocale()` — the cache this file is still
 * initialising — so the first import would throw `Cannot access 'activeLocale' before
 * initialization`. Callers pass each label through `t()` where they render it instead.
 */
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

/**
 * Where a suite pins the language, on `globalThis`.
 *
 * The app's tests assert the English sentences this code was written in — `role="button"` and name
 * "Browser", not "浏览器" — and only the translated document is what a person reads. So the suite
 * preloads exactly one language and the assertions keep reading the source strings; the product
 * default stays Chinese, which is what `resolveLocale` says when nothing is stored.
 */
export const LOCALE_OVERRIDE_KEY = "__ccpbotLocale";

/** The pinned language, or null when nothing (or nothing this build ships) is pinned. */
function readOverride(): Locale | null {
  const pinned: unknown = (globalThis as Record<string, unknown>)[
    LOCALE_OVERRIDE_KEY
  ];
  return typeof pinned === "string" ? parseStoredLocale(pinned) : null;
}

export function currentLocale(): Locale {
  if (activeLocale !== null) {
    return activeLocale;
  }
  const override = readOverride();
  if (override !== null) {
    activeLocale = override;
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
