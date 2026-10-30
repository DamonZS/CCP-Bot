import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCALE,
  LOCALE_OVERRIDE_KEY,
  LOCALE_STORAGE_KEY,
  applyLocale,
  currentLocale,
  resetLocaleCache,
  t,
  tf,
} from "../src/lib/i18n";

/**
 * The dictionary lookup, and the one setting that reaches every string in the app.
 *
 * A test suite runs in the source language (the preload pins it, see `app/tests/preload.ts`), so
 * these cases lift that pin to look at what a person reading Chinese actually gets: an entry that
 * exists, a sentence that does not, and a value whose `{placeholder}` is filled in.
 */

/** What the preload pinned, restored after every case so the rest of the suite is unaffected. */
const pinned = (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[
  LOCALE_OVERRIDE_KEY
];

beforeEach(() => {
  delete (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[
    LOCALE_OVERRIDE_KEY
  ];
  resetLocaleCache();
});

afterEach(() => {
  if (pinned === undefined) {
    delete (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[
      LOCALE_OVERRIDE_KEY
    ];
  } else {
    (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[LOCALE_OVERRIDE_KEY] =
      pinned;
  }
  resetLocaleCache();
});

describe("the language a build starts in", () => {
  test("an unstored browser reads Chinese, whatever its navigator says", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    expect(currentLocale()).toBe("zh-CN");
  });

  test("a stored choice wins over the default", () => {
    (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[LOCALE_OVERRIDE_KEY] =
      "en";
    resetLocaleCache();
    expect(currentLocale()).toBe("en");
  });

  test("a value this build does not ship is not a language", () => {
    (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[LOCALE_OVERRIDE_KEY] =
      "de";
    resetLocaleCache();
    expect(currentLocale()).toBe("zh-CN");
  });
});

describe("t()", () => {
  test("a sentence in the catalogue is drawn in Chinese", () => {
    expect(t("Settings")).toBe("设置");
    expect(t("Cancel")).toBe("取消");
  });

  test("a sentence the catalogue does not carry stays as written", () => {
    expect(t("A sentence nobody translated")).toBe(
      "A sentence nobody translated",
    );
    expect(t("")).toBe("");
  });

  test("English draws the source sentence it was given", () => {
    (globalThis as { [LOCALE_OVERRIDE_KEY]?: unknown })[LOCALE_OVERRIDE_KEY] =
      "en";
    resetLocaleCache();
    expect(t("Settings")).toBe("Settings");
  });
});

describe("tf()", () => {
  test("a placeholder is filled from the caller's values", () => {
    expect(tf("{count} conversations", { count: "3" })).toBe("3 conversations");
  });

  test("a placeholder the caller did not pass is left standing", () => {
    expect(tf("Hello {name}", {})).toBe("Hello {name}");
  });
});

describe("applyLocale()", () => {
  test("records the choice under the app's own key", () => {
    const writes: [string, string][] = [];
    applyLocale("en", {
      getStoredValue: () => null,
      setStoredValue: (key, value) => writes.push([key, value]),
    });
    expect(writes).toEqual([[LOCALE_STORAGE_KEY, "en"]]);
    expect(LOCALE_STORAGE_KEY).toBe("ccpbot-locale");
  });
});
