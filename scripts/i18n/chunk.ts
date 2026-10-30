/**
 * Splits the strings that still need translating into chunks.
 *
 *   bun scripts/i18n/chunk.ts
 *
 * A string counts as done once the catalogue has an entry for it, so re-running this after adding
 * new screens produces a small set of chunks rather than the same thirteen every time.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const SIZE = 120;

type Inventory = { entries: { source: string; count: number }[] };

const inventory = JSON.parse(
  readFileSync("scripts/i18n/inventory.json", "utf8"),
) as Inventory;

const dir = "scripts/i18n/chunks";
mkdirSync(dir, { recursive: true });

const translated = new Set<string>();
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".zh.json")) {
    continue;
  }
  const map = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Record<
    string,
    string
  >;
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && value.trim().length > 0) {
      translated.add(key);
    }
  }
}

let nextId = 0;
for (const file of readdirSync(dir)) {
  const match = /^chunk-(\d+)\.json$/.exec(file);
  if (match) {
    nextId = Math.max(nextId, Number(match[1]) + 1);
  }
}

const pending = inventory.entries
  .map((entry) => entry.source)
  .filter((source) => !translated.has(source))
  // Longest first, so a chunk's terminology settles on sentences before it meets the fragments.
  .sort((a, b) => b.length - a.length);

for (let start = 0; start < pending.length; start += SIZE) {
  const slice = pending.slice(start, start + SIZE);
  const id = String(nextId).padStart(2, "0");
  writeFileSync(
    `${dir}/chunk-${id}.json`,
    `${JSON.stringify(slice, null, 2)}\n`,
  );
  console.log(`chunk-${id}: ${slice.length} strings`);
  nextId += 1;
}

console.log(
  `${inventory.entries.length} in inventory, ${translated.size} translated, ${pending.length} pending`,
);