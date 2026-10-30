/**
 * Renames the product from OpenBot to CCP-Bot across every tracked text file.
 *
 *   bun scripts/rebrand.ts            # dry run: report what would change
 *   bun scripts/rebrand.ts --write
 *
 * One sweep, in order, because the forms nest: `openbot-theme` must become `ccpbot-theme` before the
 * display form is looked for, and `OPENBOT_APP_URL` must not be read as the word `openbot`.
 *
 * Three things are deliberately left alone:
 *
 * - The licence, which carries the upstream copyright line.
 * - Links to the upstream project. The code is a fork and taking credit for its home page would be a
 *   lie, so `github.com/CopilotKit/OpenBot` keeps pointing where it points.
 * - The changelog, whose older entries record what happened under the old name.
 */
import { readFileSync, writeFileSync } from "node:fs";

const WRITE = process.argv.includes("--write");

/** Files that must keep the old name. */
const SKIP = [
  /^LICENSE/i,
  /(^|\/)CHANGELOG/i,
  /bun\.lock$/,
  /package-lock\.json$/,
  /(^|\/)\.i18n-.*\.json$/,
  /\.log$/,
];

/** Substrings that must survive the sweep untouched, replaced around instead of through. */
const PROTECTED = [
  "github.com/CopilotKit/OpenBot",
  "github.com/repos/CopilotKit/OpenBot",
  "jerelvelarde/awesome-openbot",
];

/**
 * Order matters and is the whole trick: `OPENBOT_APP_URL` contains neither `OpenBot` nor a bare
 * `openbot`, and `openbot-theme` would be mangled by the display rule if that ran first.
 */
const RULES: [
  RegExp,
  string | ((match: string, offset: number, whole: string) => string),
][] = [
  [/ai\.copilotkit\.openbot/g, "app.ccpbot"],
  [/OPENBOT_/g, "CCPBOT_"],
  [/OpenBot/g, displayName],
  // `openbot` never appears mid-identifier with a hyphen problem — it stays one word — so the
  // lowercase form is a plain swap and `ccpbot` reads the same in code as `openbot` did.
  [/openbot/g, "ccpbot"],
  [/OPENBOT/g, "CCPBOT"],
];

/** Characters that, next to a name, make it part of an identifier rather than running prose. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * The display name is `CCP-Bot`, but `OpenBotRole` and `hasOpenBotAccess` are identifiers and a
 * hyphen would end the token: TypeScript reports `',' expected` at the hyphen rather than anything
 * that names the real problem. Inside an identifier the name becomes `CcpBot`, which keeps the
 * exported API readable and the diff mechanical.
 */
function displayName(match: string, offset: number, whole: string): string {
  const before = offset > 0 ? whole[offset - 1] : "";
  const after = whole[offset + match.length] ?? "";
  return IDENTIFIER_CHAR.test(before) || IDENTIFIER_CHAR.test(after)
    ? "CcpBot"
    : "CCP-Bot";
}

/**
 * Repairs the hyphen-in-identifier damage an earlier, identifier-blind sweep left behind. Run with
 * `--repair-idents`; it only looks at `CCP-Bot` next to identifier characters, so prose is safe.
 */
function repairIdentifierNames(text: string): string {
  return text.replace(/CCP-Bot/g, (match, offset: number, whole: string) => {
    const before = offset > 0 ? whole[offset - 1] : "";
    const after = whole[offset + match.length] ?? "";
    return IDENTIFIER_CHAR.test(before) || IDENTIFIER_CHAR.test(after)
      ? "CcpBot"
      : match;
  });
}

const files = Bun.spawnSync(["git", "ls-files"], {
  cwd: process.cwd(),
})
  .stdout.toString()
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((path) => !SKIP.some((pattern) => pattern.test(path)));

let changedFiles = 0;
const totals = new Map<string, number>();

if (process.argv.includes("--repair-idents")) {
  let repaired = 0;
  for (const path of files) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("CCP-Bot")) {
      continue;
    }
    const next = repairIdentifierNames(text);
    if (next !== text) {
      repaired += 1;
      if (WRITE) {
        writeFileSync(path, next);
      }
    }
  }
  console.log(
    `${repaired} files ${WRITE ? "repaired" : "would be repaired"} (${files.length} scanned)`,
  );
  process.exit(0);
}

for (const path of files) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  // A handful of NUL bytes is not a reason to skip a source file: `desktop/src-tauri/src`
  // contains tar headers written as byte strings with a literal NUL in them. Only a file that is
  // mostly NUL is binary, whatever its name says.
  const nuls = (text.match(/\0/g) ?? []).length;
  if (nuls > text.length / 200) {
    continue;
  }
  if (!/openbot/i.test(text)) {
    continue;
  }

  let next = text;
  for (const [index, token] of PROTECTED.entries()) {
    next = next.split(token).join(`\u0000PROTECTED${index}\u0000`);
  }
  for (const [pattern, replacement] of RULES) {
    const matches = next.match(pattern);
    if (matches) {
      totals.set(
        `${pattern.source} -> ${replacement}`,
        (totals.get(`${pattern.source} -> ${replacement}`) ?? 0) +
          matches.length,
      );
      next = next.replace(
        pattern,
        replacement as string & ((match: string) => string),
      );
    }
  }
  for (const [index, token] of PROTECTED.entries()) {
    next = next.split(`\u0000PROTECTED${index}\u0000`).join(token);
  }

  if (next !== text) {
    changedFiles += 1;
    if (WRITE) {
      writeFileSync(path, next);
    }
  }
}

for (const [rule, count] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(6)}  ${rule}`);
}
console.log(
  `${changedFiles} files ${WRITE ? "rewritten" : "would change"} (${files.length} scanned)`,
);
