import { EMBEDDING_DIMENSIONS, type MemoryEmbeddingConfig } from "./config";

/**
 * Turning a text into a vector, or saying why it cannot.
 *
 * `embed` answers `undefined` rather than throwing: a deployment with no embedding endpoint still
 * stores and still recalls memories, by keyword, and every caller here is written to carry on from
 * that. What it never does is answer with a vector it did not receive — a made-up vector would rank
 * memories by nothing at all while looking exactly like a working feature.
 */
export type Embedder = {
  model: string;
  dimensions: number;
  /** The vectors for these texts, in the same order, or `undefined` when they cannot be had. */
  embed(texts: string[]): Promise<number[][] | undefined>;
};

const REQUEST_TIMEOUT_MS = 20_000;
/** How long one failure is trusted to keep failing. Long enough to stop a retry per write. */
const FAILURE_TTL_MS = 60_000;

/**
 * Where the vectors are asked for. The version segment is added only when the configured URL does
 * not already end in one — the rule `chatCompletionsUrl` in `routing/model.ts` follows, and for the
 * same reason: a gateway's base URL may or may not carry it, while the public API's own default
 * (`https://api.openai.com`) does not. Without this, the unset case asked
 * `https://api.openai.com/embeddings`, which answers nothing.
 */
export function embeddingsUrl(baseUrl: string): string {
  return /\/v\d+$/.test(baseUrl)
    ? `${baseUrl}/embeddings`
    : `${baseUrl}/v1/embeddings`;
}

export function createEmbedder(
  config: MemoryEmbeddingConfig | undefined,
  options: {
    fetchImpl?: typeof fetch;
    log?: (line: Record<string, unknown>) => void;
    now?: () => number;
  } = {},
): Embedder {
  const log = options.log ?? ((line) => console.warn(JSON.stringify(line)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  /*
   * The column is `vector(1536)`: a narrower or wider declaration cannot be honoured, and a stored
   * vector of the wrong width would take the index down with it. Said once, and the feature stays
   * off until the migration and the declaration agree.
   */
  const mismatched =
    config !== undefined && config.dimensions !== EMBEDDING_DIMENSIONS;
  let saidMismatch = false;
  let heldUntil = 0;

  const failed = (reason: string): undefined => {
    heldUntil = now() + FAILURE_TTL_MS;
    log({
      type: "memory-embedding-failed",
      model: config?.model ?? "",
      reason,
      note: "The memory is stored either way; recall falls back to keywords until the endpoint answers.",
    });
    return undefined;
  };

  return {
    model: config?.model ?? "",
    dimensions: config?.dimensions ?? EMBEDDING_DIMENSIONS,
    async embed(texts: string[]): Promise<number[][] | undefined> {
      if (!config || texts.length === 0) return undefined;
      if (mismatched) {
        if (!saidMismatch) {
          saidMismatch = true;
          log({
            type: "memory-embedding-dimension-mismatch",
            declared: config.dimensions,
            stored: EMBEDDING_DIMENSIONS,
            reason: `MEMORY_EMBEDDING_DIM declares ${config.dimensions} dimensions and the embedding column holds ${EMBEDDING_DIMENSIONS}, so no vector is written and recall stays by keyword. Change the declaration, or add a migration that recreates the column and its index at the new width and re-embeds what is stored.`,
          });
        }
        return undefined;
      }
      if (now() < heldUntil) return undefined;
      try {
        const response = await fetchImpl(embeddingsUrl(config.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey
              ? { authorization: `Bearer ${config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return failed(`HTTP ${response.status}`);
        const body = (await response.json()) as {
          data?: Array<{ embedding?: unknown; index?: unknown }>;
        };
        const vectors = readVectors(body, texts.length, config.dimensions);
        if (!vectors) {
          return failed(
            "The endpoint answered with something other than one vector per text.",
          );
        }
        return vectors;
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** One vector per text, each of the declared width. Anything else is not a usable answer. */
function readVectors(
  body: { data?: Array<{ embedding?: unknown; index?: unknown }> },
  expected: number,
  dimensions: number,
): number[][] | undefined {
  const data = body.data;
  if (!Array.isArray(data) || data.length !== expected) return undefined;
  const ordered = [...data].sort(
    (left, right) => numberOf(left.index, 0) - numberOf(right.index, 0),
  );
  const vectors: number[][] = [];
  for (const entry of ordered) {
    if (!Array.isArray(entry.embedding)) return undefined;
    if (entry.embedding.length !== dimensions) return undefined;
    if (
      !entry.embedding.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      return undefined;
    }
    vectors.push(entry.embedding as number[]);
  }
  return vectors;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}