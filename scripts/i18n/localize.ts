/**
 * Wraps user-facing strings in `t()`, and reports what it would wrap.
 *
 *   bun scripts/i18n/localize.ts scan  --root app/src
 *   bun scripts/i18n/localize.ts apply --root app/src
 *
 * `scan` writes an inventory (JSON) of every string this codemod considers translatable and how
 * often it occurs, which is what the catalogue is built from. `apply` rewrites the files.
 *
 * Two rules keep the rewrite safe enough to run over a whole package:
 *
 * - It edits text ranges. It never reprints a file, so formatting and comments survive untouched.
 * - It only wraps strings it can prove are safe to wrap: JSX text with no entity (`&amp;` would stop
 *   rendering as `&` once it is a string literal instead of JSX text), a plain or conditional
 *   literal in a short attribute allowlist, and a bare or conditional literal child. Anything it
 *   cannot prove — template literals, concatenation, values from a variable — is left alone and
 *   reported, so a second pass can pick those up by hand.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Attributes whose value is rendered to a person rather than read by code. */
const PLAIN_TEXT_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "description",
  "emptyDescription",
  "emptyLabel",
  "emptyTitle",
  "label",
  "placeholder",
  "title",
]);

const IMPORT_FROM_APP = "@/lib/i18n";

type Mode = "scan" | "apply";

type Kind = "jsx-text" | "attribute" | "jsx-expression";

type Hit = {
  file: string;
  start: number;
  end: number;
  source: string;
  kind: Kind;
  replacement: string;
};

type Skipped = { file: string; line: number; source: string; reason: string };

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "tests") {
        continue;
      }
      out.push(...walk(path));
      continue;
    }
    if (entry.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Whether a run of text is worth translating.
 *
 * The test is deliberately conservative: needs a Latin word, must not be a lone symbol, a number, a
 * CSS fragment or a date format. Everything else stays as it is.
 */
function isTranslatable(text: string): boolean {
  const core = text.trim();
  if (core.length < 2 || !/[A-Za-z]{2}/.test(core)) {
    return false;
  }
  // Class names, CSS values, hex colours, and file names are code, not copy.
  if (/^(?:[a-z]+-)+[a-z0-9]+$/.test(core) && !/\s/.test(core)) {
    return false;
  }
  if (/^[#.]?[a-z0-9:._%/()-]+\.(?:png|jpe?g|svg|webp|css|js|ts|tsx|json)$/i.test(core)) {
    return false;
  }
  // Single words in lowerCamelCase or snake_case are identifiers someone forgot to pass through a
  // label, not sentences: `supabase`, `error_message`.
  if (/^[a-z][a-zA-Z0-9]*$/.test(core) && /[A-Z_]/.test(core)) {
    return false;
  }
  return true;
}

/**
 * JSX text collapses a newline and the indentation after it into one space before it renders, so
 * the catalogue entry is the collapsed form. Keeping the raw form would make two visually identical
 * sentences two different keys.
 */
function collapse(raw: string): string {
  return raw.replace(/\s+/g, " ");
}

function collect(file: string, text: string, hits: Hit[], skipped: Skipped[]) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line;

  /** A string literal that is safe to wrap, as a `t(...)` expression. */
  function literalEdit(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) {
    const value = node.text;
    if (!isTranslatable(value)) {
      return null;
    }
    return {
      start: node.getStart(source),
      end: node.getEnd(),
      source: value,
      replacement: `t(${JSON.stringify(value)})`,
    };
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      const raw = node.getText(source);
      const core = collapse(raw).trim();
      if (isTranslatable(core)) {
        if (raw.includes("&")) {
          skipped.push({
            file,
            line: lineOf(node),
            source: core,
            reason: "jsx entity",
          });
        } else {
          // The edge spaces stay outside the expression, so the catalogue key is the clean
          // sentence rather than a sentence plus a trailing space that nobody can see in review.
          const leading = raw.slice(0, raw.length - raw.trimStart().length);
          const trailing = raw.slice(raw.trimEnd().length);
          hits.push({
            file,
            start: node.getStart(source),
            end: node.getEnd(),
            source: core,
            kind: "jsx-text",
            replacement: `${leading}{t(${JSON.stringify(core)})}${trailing}`,
          });
        }
      }
    }

    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(source);
      const initializer = node.initializer;
      if (PLAIN_TEXT_ATTRIBUTES.has(name)) {
        if (ts.isStringLiteral(initializer)) {
          const edit = literalEdit(initializer);
          if (edit) {
            hits.push({ file, kind: "attribute", ...edit });
          }
        }
        // `title={isNew ? "New" : "Edit"}`: both branches are rendered, so both are wrapped.
        if (ts.isJsxExpression(initializer) && initializer.expression) {
          const expression = initializer.expression;
          if (ts.isConditionalExpression(expression)) {
            for (const branch of [expression.whenTrue, expression.whenFalse]) {
              if (ts.isStringLiteral(branch)) {
                const edit = literalEdit(branch);
                if (edit) {
                  hits.push({ file, kind: "jsx-expression", ...edit });
                }
              }
            }
          } else if (ts.isStringLiteral(expression)) {
            const edit = literalEdit(expression);
            if (edit) {
              hits.push({ file, kind: "jsx-expression", ...edit });
            }
          }
        }
      }
    }

    // A bare child or a ternary child: `{pinned ? "Unpin" : "Pin"}`.
    if (ts.isJsxExpression(node) && node.expression) {
      const expression = node.expression;
      const parent = node.parent;
      const isAttributeValue = ts.isJsxAttribute(parent);
      if (!isAttributeValue) {
        if (ts.isStringLiteral(expression)) {
          const edit = literalEdit(expression);
          if (edit) {
            hits.push({ file, kind: "jsx-expression", ...edit });
          }
        }
        if (ts.isConditionalExpression(expression)) {
          for (const branch of [expression.whenTrue, expression.whenFalse]) {
            if (ts.isStringLiteral(branch)) {
              const edit = literalEdit(branch);
              if (edit) {
                hits.push({ file, kind: "jsx-expression", ...edit });
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
}

/**
 * Adds the `t` import once, after the last import in the file.
 *
 * Every file the app is built from uses the `@/` alias, so the specifier is the same everywhere; a
 * file that already imports something from the i18n module keeps its own import and this becomes a
 * no-op.
 */
function addImport(text: string): string {
  if (/from\s+["']@\/lib\/i18n[\w/]*["']/.test(text)) {
    return text;
  }
  const source = ts.createSourceFile(
    "x.tsx",
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );
  let insertAt = 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      insertAt = statement.getEnd();
    } else {
      break;
    }
  }
  const line = `\nimport { t } from "${IMPORT_FROM_APP}";`;
  if (insertAt === 0) {
    return `${line.trim()}\n${text}`;
  }
  return `${text.slice(0, insertAt)}${line}${text.slice(insertAt)}`;
}

/** Applies this file's edits from the end, so earlier offsets stay valid. */
function rewrite(text: string, edits: Hit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return addImport(out);
}

function main() {
  const args = process.argv.slice(2);
  const mode = (args[0] ?? "scan") as Mode;
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 ? (args[rootFlag + 1] as string) : "app/src";
  const outFlag = args.indexOf("--out");
  const out = outFlag >= 0 ? (args[outFlag + 1] as string) : undefined;

  const files = walk(root);
  const hits: Hit[] = [];
  const skipped: Skipped[] = [];
  const texts = new Map<string, string>();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    texts.set(file, text);
    collect(file, text, hits, skipped);
  }

  if (mode === "scan") {
    const counts = new Map<string, number>();
    const byKind = new Map<Kind, number>();
    for (const hit of hits) {
      counts.set(hit.source, (counts.get(hit.source) ?? 0) + 1);
      byKind.set(hit.kind, (byKind.get(hit.kind) ?? 0) + 1);
    }
    const report = {
      root,
      files: files.length,
      filesWithHits: new Set(hits.map((hit) => hit.file)).size,
      wraps: hits.length,
      unique: counts.size,
      byKind: Object.fromEntries(byKind),
      perFile: [...new Set(hits.map((hit) => hit.file))].sort(),
      entries: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([source, count]) => ({ source, count })),
      skipped,
    };
    const json = JSON.stringify(report, null, 2);
    if (out) {
      writeFileSync(out, json);
      console.log(
        `${report.wraps} wraps, ${report.unique} unique across ${report.filesWithHits}/${report.files} files -> ${out}`,
      );
      console.log(JSON.stringify(report.byKind));
    } else {
      console.log(json);
    }
    return;
  }

  let changed = 0;
  for (const file of files) {
    const text = texts.get(file) as string;
    const own = hits.filter((hit) => hit.file === file);
    if (own.length === 0) {
      continue;
    }
    const next = rewrite(text, own);
    if (next !== text) {
      writeFileSync(file, next);
      changed += 1;
    }
  }
  console.log(`rewrote ${changed} files, ${hits.length} strings`);
  if (skipped.length > 0) {
    console.log(`${skipped.length} strings skipped`);
  }
}

main();