import { describe, expect, test } from "bun:test";
import { memoryEmbeddingConfig } from "../src/memory/embedding/config";
import { createEmbedder, embeddingsUrl } from "../src/memory/embedding/provider";
import { chunkText } from "../src/memory/knowledge/chunk";
import {
  cosine,
  startEmbeddingEndpoint,
  vectorOf,
} from "./support/embeddings";

/**
 * Where the vectors come from, and what happens when they cannot be had. No database: this file is
 * about the endpoint, the default chain, and the chunking that decides what gets a vector at all.
 */
describe("memory embedding", () => {
  test("is absent when nothing is configured, and follows the deployment's model keys otherwise", () => {
    expect(memoryEmbeddingConfig({})).toBeUndefined();
    expect(memoryEmbeddingConfig({ OPENAI_API_KEY: "sk-openai" })).toEqual({
      baseUrl: "https://api.openai.com",
      model: "text-embedding-3-small",
      dimensions: 1_536,
      apiKey: "sk-openai",
    });
    expect(
      memoryEmbeddingConfig({
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "https://proxy.internal/v1",
        MEMORY_EMBEDDING_API_KEY: "sk-memory",
        MEMORY_EMBEDDING_BASE_URL: "http://127.0.0.1:9000/",
        MEMORY_EMBEDDING_MODEL: "local-embed",
        MEMORY_EMBEDDING_DIM: "768",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:9000",
      model: "local-embed",
      dimensions: 768,
      apiKey: "sk-memory",
    });
    // An endpoint named without a key is a deployment that runs its own model server.
    expect(
      memoryEmbeddingConfig({ MEMORY_EMBEDDING_BASE_URL: "http://127.0.0.1:9000" }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:9000",
      model: "text-embedding-3-small",
      dimensions: 1_536,
    });
    expect(() =>
      memoryEmbeddingConfig({ MEMORY_EMBEDDING_BASE_URL: "not a url" }),
    ).toThrow();
    expect(() =>
      memoryEmbeddingConfig({ MEMORY_EMBEDDING_DIM: "zero" }),
    ).toThrow();
  });

  test("asks the endpoint under a version segment, the way chatCompletionsUrl does", () => {
    /*
     * The unset default is OpenAI's own host without a version, so one has to be added; a base URL
     * that already ends in one keeps it, or a gateway would be asked for `/v1/v1/embeddings`.
     */
    expect(embeddingsUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/embeddings",
    );
    expect(embeddingsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/embeddings",
    );
    expect(embeddingsUrl("https://gateway.internal/api/v2")).toBe(
      "https://gateway.internal/api/v2/embeddings",
    );
    expect(embeddingsUrl("http://127.0.0.1:9000")).toBe(
      "http://127.0.0.1:9000/v1/embeddings",
    );
  });

  test("a declared width that does not match the column stores nothing, and says so once", async () => {
    const endpoint = await startEmbeddingEndpoint();
    const warnings: Record<string, unknown>[] = [];
    const embedder = createEmbedder(
      {
        baseUrl: endpoint.url,
        model: "test-embedding",
        dimensions: 768,
        apiKey: "test-key",
      },
      { log: (line) => warnings.push(line) },
    );
    try {
      expect(await embedder?.embed(["deploy pipeline"])).toBeUndefined();
      expect(await embedder?.embed(["deploy pipeline"])).toBeUndefined();
      expect(endpoint.requests()).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.type).toBe("memory-embedding-dimension-mismatch");
      expect(warnings[0]?.stored).toBe(1_536);
    } finally {
      await endpoint.stop();
    }
  });

  test("asks a real endpoint over HTTP and gets vectors that describe the text", async () => {
    const endpoint = await startEmbeddingEndpoint();
    const embedder = createEmbedder({
      baseUrl: endpoint.url,
      model: "test-embedding",
      dimensions: 1_536,
      apiKey: "test-key",
    });
    try {
      const embedded = await embedder?.embed(["deploy pipeline", "lunch is at noon"]);
      expect(embedded).toHaveLength(2);
      expect(embedded?.[0]).toHaveLength(1_536);
      expect(endpoint.requests()).toBe(1);
      const query = vectorOf("deploy pipeline");
      expect(cosine(embedded?.[0] ?? [], query)).toBeCloseTo(1, 6);
      expect(cosine(embedded?.[1] ?? [], query)).toBeCloseTo(0, 6);
    } finally {
      await endpoint.stop();
    }
  });

  test("an endpoint that fails stores nothing, and is not asked again for a minute", async () => {
    const endpoint = await startEmbeddingEndpoint({ failWith: 500 });
    const warnings: Record<string, unknown>[] = [];
    const embedder = createEmbedder(
      {
        baseUrl: endpoint.url,
        model: "test-embedding",
        dimensions: 1_536,
        apiKey: "test-key",
      },
      { log: (line) => warnings.push(line) },
    );
    try {
      expect(await embedder?.embed(["deploy pipeline"])).toBeUndefined();
      const after = endpoint.requests();
      expect(after).toBe(1);
      expect(await embedder?.embed(["deploy pipeline"])).toBeUndefined();
      expect(endpoint.requests()).toBe(after);
      expect(warnings.map((line) => line.type)).toEqual([
        "memory-embedding-failed",
      ]);
    } finally {
      await endpoint.stop();
    }
  });
});

describe("chunking", () => {
  test("packs blocks up to the limit and keeps the heading", () => {
    const chunks = chunkText(
      "# Deploys\n\nThe deploy pipeline runs before it ships.\n\nThe rollback is one command.",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.position).toBe(0);
    expect(chunks[0]?.heading).toBe("Deploys");
    expect(chunks[0]?.content).toContain("The rollback is one command.");
  });

  test("splits a long document, and never past the limit", () => {
    const paragraph = `${"lorem ipsum dolor sit amet ".repeat(20)}\n`;
    const chunks = chunkText(paragraph.repeat(6));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1_200);
    const positions = chunks.map((chunk) => chunk.position);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});