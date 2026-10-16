/**
 * Pluggable embedding interface + Ollama (OpenAI-compatible) implementation.
 */

export interface Embedder {
  /** Embed one text into a numeric vector. Throws on failure. */
  embed(text: string): Promise<number[]>;
}

export interface EmbedderStatus {
  available: boolean;
  error?: string; // set when !available
}

export interface OllamaEmbedderOptions {
  baseUrl?: string; // default: env SEMANTIC_MEMORY_EMBED_URL or "http://localhost:11434"
  model?: string; // default: env SEMANTIC_MEMORY_EMBED_MODEL or "embeddinggemma"
  fetch?: typeof fetch; // injectable for tests
}

function parseEmbedding(json: unknown): number[] {
  if (typeof json !== "object" || json === null) {
    throw new Error("embed failed: invalid response");
  }
  const embeddings = (json as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new Error("embed failed: invalid response");
  }
  const first = embeddings[0];
  if (
    !Array.isArray(first) ||
    first.length === 0 ||
    !first.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new Error("embed failed: invalid response");
  }
  return first;
}

/** OpenAI-compatible embedder against Ollama's /api/embed. */
export function createOllamaEmbedder(options?: OllamaEmbedderOptions): Embedder {
  const fetchImpl = options?.fetch ?? globalThis.fetch;

  return {
    async embed(text: string): Promise<number[]> {
      // Env overrides are read at call time, not cached.
      const baseUrl = (
        options?.baseUrl ??
        process.env.SEMANTIC_MEMORY_EMBED_URL ??
        "http://localhost:11434"
      ).replace(/\/+$/, "");
      const model =
        options?.model ?? process.env.SEMANTIC_MEMORY_EMBED_MODEL ?? "embeddinggemma";

      const response = await fetchImpl(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(2000),
      });

      if (!response.ok) {
        throw new Error(`embed failed: HTTP ${response.status}`);
      }

      const json: unknown = await response.json();
      return parseEmbedding(json);
    },
  };
}

/** Probe the embedder with a tiny request. Never throws. */
export async function probeEmbedder(embedder: Embedder): Promise<EmbedderStatus> {
  try {
    await embedder.embed("ping");
    return { available: true };
  } catch (e) {
    return { available: false, error: String((e as Error).message) };
  }
}
