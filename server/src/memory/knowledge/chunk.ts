export type KnowledgeChunk = {
  position: number;
  heading: string | null;
  content: string;
};

/**
 * How much text one chunk holds. A chunk is what gets a vector, so this is the unit a search can
 * point at: small enough that a hit names something a person can read, large enough that a
 * paragraph is not split away from the sentence that explains it.
 */
export const CHUNK_CHARS = 1_200;

/**
 * A document split into chunks, in reading order.
 *
 * Blank lines end a block, and blocks are packed into chunks until the next one would not fit.
 * Nothing overlaps: two vectors over the same sentence would return it twice, and the caller can
 * read the neighbours from `position` if a chunk is cut short. A block longer than the limit is
 * split at the last line break before the limit, because cutting mid-word costs an embedding.
 */
export function chunkText(text: string, limit = CHUNK_CHARS): KnowledgeChunk[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const chunks: KnowledgeChunk[] = [];
  let current = "";
  const flush = () => {
    const content = current.trim();
    current = "";
    if (content.length === 0) return;
    chunks.push({
      position: chunks.length,
      heading: headingOf(content),
      content,
    });
  };
  for (const block of blocks) {
    for (const piece of splitOversized(block, limit)) {
      if (current.length === 0) current = piece;
      else if (current.length + 2 + piece.length <= limit)
        current = `${current}\n\n${piece}`;
      else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return chunks;
}

/** The first line of a markdown-ish block, without its `#`s, when it is written as one. */
function headingOf(content: string): string | null {
  const [first = ""] = content.split("\n");
  if (!first.startsWith("#")) return null;
  const heading = first.replace(/^#+\s*/, "").trim();
  return heading.length > 0 ? heading : null;
}

function splitOversized(block: string, limit: number): string[] {
  if (block.length <= limit) return [block];
  const pieces: string[] = [];
  let rest = block;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = at > limit / 2 ? at : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
}