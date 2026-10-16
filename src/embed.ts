/**
 * Pluggable embedding interface + Ollama (OpenAI-compatible) implementation.
 * Implemented in Phase 3 by embed-agent.
 */

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface EmbedderStatus {
  available: boolean;
  error?: string;
}

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

export function createOllamaEmbedder(_options?: OllamaEmbedderOptions): Embedder {
  throw new Error("not implemented");
}

export function probeEmbedder(_embedder: Embedder): Promise<EmbedderStatus> {
  throw new Error("not implemented");
}
