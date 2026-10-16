/**
 * Cosine-similarity search over the memory index.
 * Implemented in Phase 3 by store-agent.
 */

import type { Embedder } from "./embed.ts";
import type { MemoryIndex } from "./store.ts";

export interface SearchResult {
  filePath: string;
  score: number;
}

export function cosineSimilarity(_a: number[], _b: number[]): number {
  throw new Error("not implemented");
}

export function search(
  _query: string,
  _topK: number,
  _embedder: Embedder,
  _index: MemoryIndex,
): Promise<SearchResult[]> {
  throw new Error("not implemented");
}
