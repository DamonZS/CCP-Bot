/**
 * Where this deployment's embeddings come from.
 *
 * A deployment that can already call a model can usually embed with it, so the default is the
 * deployment's own model credentials rather than a service of its own — `MEMORY_EMBEDDING_*` is
 * there to point somewhere else, not to be required. A deployment that has neither still runs: see
 * `provider.ts` for what an unusable endpoint means, and `store.ts` for what recall does then.
 *
 * The key is read from the environment and from nowhere else. Both routes put model credentials
 * there (the desktop route through the vault, the container route through compose), and a key
 * written into `.env` would be a second, drifting answer to a question the environment already
 * answers.
 */
export const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = EMBEDDING_DIMENSIONS;

export type MemoryEmbeddingConfig = {
  baseUrl: string;
  model: string;
  /**
   * What the endpoint is expected to answer with. The column this is stored in is fixed at
   * `EMBEDDING_DIMENSIONS`; a declaration that disagrees is not honoured — the writer refuses to
   * store vectors of the wrong width rather than storing them and losing the index. See
   * `provider.ts`.
   */
  dimensions: number;
  apiKey?: string;
};

export function memoryEmbeddingConfig(
  environment: Record<string, string | undefined>,
): MemoryEmbeddingConfig | undefined {
  const baseUrl = optional(environment, "MEMORY_EMBEDDING_BASE_URL");
  const model = optional(environment, "MEMORY_EMBEDDING_MODEL");
  const dimension = optional(environment, "MEMORY_EMBEDDING_DIM");
  const explicitKey = optional(environment, "MEMORY_EMBEDDING_API_KEY");
  const apiKey = explicitKey ?? optional(environment, "OPENAI_API_KEY");
  /*
   * Naming any `MEMORY_EMBEDDING_*` is a deployment saying "embed here", and an endpoint that wants
   * no key is a legitimate answer (a model server on the loopback address). Saying nothing at all
   * means "use whatever model credentials this deployment already has", and with none there is
   * nothing to follow.
   */
  const asked = [baseUrl, model, dimension, explicitKey].some((value) => value !== undefined);
  if (!asked && !apiKey) return undefined;
  return {
    baseUrl: parseBaseUrl(
      baseUrl ?? optional(environment, "OPENAI_BASE_URL") ?? DEFAULT_BASE_URL,
    ),
    model: model ?? DEFAULT_MODEL,
    dimensions: parseDimensions(dimension),
    ...(apiKey ? { apiKey } : {}),
  };
}

function optional(
  environment: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return environment[name]?.trim() || undefined;
}

/** The same shape `dictation/config.ts` uses: a real http(s) endpoint, with nothing else in it. */
function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `MEMORY_EMBEDDING_BASE_URL is not a URL: ${raw}. Give an http or https address of an embeddings endpoint.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `MEMORY_EMBEDDING_BASE_URL must be http or https, not ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "MEMORY_EMBEDDING_BASE_URL must not carry credentials: put the key in MEMORY_EMBEDDING_API_KEY.",
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      "MEMORY_EMBEDDING_BASE_URL must not carry a query or a fragment.",
    );
  }
  return url.href.replace(/\/+$/, "");
}

function parseDimensions(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DIMENSIONS;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) {
    throw new Error(
      `MEMORY_EMBEDDING_DIM must be a positive whole number of dimensions, not ${raw}.`,
    );
  }
  return Number(raw);
}