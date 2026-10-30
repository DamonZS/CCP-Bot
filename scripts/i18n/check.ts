/**
 * Reports every source string the app passes to `t()` that has no Chinese entry.
 *
 *   bun scripts/i18n/check.ts            # list what is missing
 *   bun scripts/i18n/check.ts --json      # same, for a script
 *
 * The catalogue is keyed by the English sentence, so a missing entry is not an error at runtime:
 * the sentence renders as written. It is still a gap a person reading the Chinese interface sees,
 * which is what this reports. Entries written by hand after the codemod ran are the usual source:
 * they were never in the inventory `merge.ts` merges from.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const APP_SRC = join(import.meta.dir, "..", "..", "app", "src");
const CATALOGUE = join(APP_SRC, "lib", "i18n", "messages", "zh-CN.ts");

/** Every `.ts`/`.tsx` file under `app/src`, minus the i18n module that holds the dictionary. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "i18n" || entry.name === "node_modules") {
        continue;
      }
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

const used = new Map<string, string[]>();
for (const path of sourceFiles(APP_SRC)) {
  const text = readFileSync(path, "utf8");
  if (!/\btf?\s*\(/.test(text)) {
    continue;
  }
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "t" || node.expression.text === "tf")
    ) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first)) {
        const list = used.get(first.text) ?? [];
        list.push(relative(APP_SRC, path));
        used.set(first.text, list);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const catalogue = await import(CATALOGUE.replace(/\\/g, "/"));
const entries: Record<string, string> = catalogue.ZH_CN;

const missing = [...used.entries()]
  .filter(([source, files]) => !(source in entries) && files.length > 0)
  .map(([source, files]) => ({ source, files: [...new Set(files)] }))
  .sort((a, b) => a.source.localeCompare(b.source));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(missing, null, 2));
} else {
  for (const entry of missing) {
    console.log(`${entry.source}\n    ${entry.files.join(", ")}`);
  }
  console.log(
    `${missing.length} missing, ${used.size} source strings used, ${Object.keys(entries).length} entries in the catalogue`,
  );
}
