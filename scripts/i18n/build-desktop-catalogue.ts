/**
 * Writes the desktop shell's Chinese catalogue from the pieces around it.
 *
 * The shell's strings were collected by `localize.ts scan --root desktop/src`, translated, and are
 * now merged here: anything the interface already translated is reused word for word (the shell and
 * the page it opens should use one vocabulary), and anything new is added from the translation file.
 * Entries are emitted in one sorted list so a later diff shows only real changes.
 *
 *   bun scripts/i18n/build-desktop-catalogue.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const repository = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (path: string) => readFileSync(`${repository}${path}`, "utf8");

const missing: string[] = JSON.parse(read("scripts/i18n/desktop-missing.json"));
const shared: string[] = JSON.parse(read("scripts/i18n/desktop-shared.json"));
const translated: Record<string, string> = JSON.parse(read("scripts/i18n/desktop-zh.json"));
/**
 * The sentences the shell displays that the Rust side writes.
 *
 * They are translated here rather than in the crate: the crate's own tests assert the English it
 * emits, and a log line is written for whoever reads the log, not for the person in the window. The
 * shell therefore translates what it is handed, and a sentence with no entry renders as it arrived.
 */
const fromRust: Record<string, string> = JSON.parse(read("scripts/i18n/desktop-rust-zh.json"));

const interfaceCatalogue = read("app/src/lib/i18n/messages/zh-CN.ts");
const known = new Map<string, string>();
for (const match of interfaceCatalogue.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",$/gm)) {
  known.set(JSON.parse(`"${match[1]}"`), JSON.parse(`"${match[2]}"`));
}

/**
 * Strings that stay as they are written.
 *
 * A URL is an address, a bare identifier is a name the endpoint knows, and a product is called by
 * its own name in every language — none of them gets an entry, and none of them counts as a gap.
 */
const KEPT_AS_WRITTEN = /^(https?:\/\/|[\w./:@-]+$)/;
const NAMES = new Set(["CCP-Bot", "Claude", "ChatGPT", "Claude Agent SDK", "LangGraph", "Gemini"]);

const entries = new Map<string, string>();
const absent: string[] = [];
for (const [source, translation] of Object.entries(fromRust)) {
  if (translation.trim() !== "") {
    entries.set(source, translation);
  }
}
for (const source of [...missing, ...shared]) {
  const translation = translated[source] ?? known.get(source);
  if (translation === undefined || translation.trim() === "") {
    if (!KEPT_AS_WRITTEN.test(source) && !NAMES.has(source)) {
      absent.push(source);
    }
    continue;
  }
  entries.set(source, translation);
}

// Where the shell renders a sentence the Rust side wrote, it renders `t(sentence)`, so those
// sentences are wrapped in the components rather than here. This file only holds the words.

if (absent.length > 0) {
  console.error(`${absent.length} string(s) have no translation yet:`);
  for (const one of absent) {
    console.error(`  ${one}`);
  }
  process.exit(1);
}

const lines = [...entries.entries()]
  .sort(([a], [b]) => a.localeCompare(b, "en"))
  .map(([source, translation]) => `  ${JSON.stringify(source)}: ${JSON.stringify(translation)},`);

writeFileSync(
  `${repository}desktop/src/lib/i18n-messages.ts`,
  `/**
 * Everything the desktop shell says, in Chinese.
 *
 * Keyed by the English sentence: the shell's source keeps the sentence it was written with, and a
 * lookup that misses renders that sentence — so a gap shows up as English in one place rather than
 * as a blank label. See \`i18n.ts\` for how the language is chosen.
 *
 * Entries shared with the interface (\`app/src/lib/i18n/messages/zh-CN.ts\`) are kept word for word
 * identical, so the shell and the page it opens use one vocabulary. Rebuild this file with
 * \`bun scripts/i18n/build-desktop-catalogue.ts\`.
 */
export const ZH_CN: Record<string, string> = {
${lines.join("\n")}
};
`,
);
console.log(`${entries.size} entries -> desktop/src/lib/i18n-messages.ts`);