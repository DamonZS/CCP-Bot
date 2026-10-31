/**
 * An embedding endpoint for tests: real HTTP, real vectors, no model and no vendor.
 *
 * The vectors are bag-of-words hashed into the column's dimensions and L2-normalized, so cosine
 * similarity between two texts is exactly the token overlap they share. That is enough to make the
 * vector half of recall do real work — a query's nearest memory is the one that shares its words —
 * while staying deterministic, offline, and free. What it deliberately cannot tell you is whether a
 * real model would agree; that question belongs to a live run, not to this suite.
 */
export type EmbeddingEndpoint = {
  url: string;
  requests: () => number;
  stop: () => Promise<void>;
};

export async function startEmbeddingEndpoint(
  options: { failWith?: number; dimensions?: number } = {},
): Promise<EmbeddingEndpoint> {
  const dimensions = options.dimensions ?? 1_536;
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests += 1;
      if (options.failWith !== undefined)
        return new Response("no", { status: options.failWith });
      const body = (await request.json()) as { input?: unknown };
      const inputs = Array.isArray(body.input) ? body.input.map(String) : [];
      return Response.json({
        object: "list",
        model: "test-embedding",
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: vectorOf(text, dimensions),
        })),
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** The environment a deployment would carry when it points at this endpoint. */
export function embeddingEnvironment(
  url: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    MEMORY_EMBEDDING_BASE_URL: url,
    MEMORY_EMBEDDING_MODEL: "test-embedding",
    MEMORY_EMBEDDING_API_KEY: "test-key",
    ...overrides,
  };
}

export function vectorOf(text: string, dimensions = 1_536): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2_166_136_261;
    for (const character of token) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619);
    }
    const index = Math.abs(hash) % dimensions;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

/** Cosine similarity, for asserting what the endpoint made of two texts. */
export function cosine(left: number[], right: number[]): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1)
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  return dot;
}