/**
 * Translation lookup, keyed by the English source string.
 *
 * `t("Save")` keeps the English sentence as the key rather than minting `save.button` ids. That
 * choice buys three things a key-based catalogue does not: a missing translation renders the
 * English sentence instead of an id or a blank, a reviewer can read the greeting inline without
 * opening a second file, and the codemod that wrapped the strings never had to invent a namespace
 * for five hundred files.
 *
 * The language is read once, when this module loads. Switching language reloads the page, so no
 * component has to subscribe to a context for the text it renders.
 */
import { currentLocale } from "./locale";
import { ZH_CN } from "./messages/zh-CN";

/** Chinese for `source`, or `source` itself when the catalogue has not caught up with it. */
export function t(source: string): string {
  if (currentLocale() !== "zh-CN") {
    return source;
  }
  const translated = ZH_CN[source];
  // An entry left as an empty string is a placeholder the generator wrote, not a translation.
  return translated !== undefined && translated.trim() !== ""
    ? translated
    : source;
}

/**
 * `t` for a sentence with holes in it: `tf("{count} bots", { count })`.
 *
 * Placeholders stay in the English source — `{count}`, not `%s` — so the catalogue entry and the
 * call site read the same, and a value can be reordered by the translation without touching code.
 */
export function tf(
  source: string,
  vars: Record<string, string | number>,
): string {
  return t(source).replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}