/**
 * Cosine-similarity search over the memory index.
 */

import { existsSync } from "node:fs";
import type { Embedder } from "./embed.ts";
import type { MemoryIndex } from "./store.ts";

export interface SearchResult {
  filePath: string;
  score: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function search(
  query: string,
  topK: number,
  embedder: Embedder,
  index: MemoryIndex,
): Promise<SearchResult[]> {
  if (topK <= 0 || index.entries.length === 0) return [];

  let vector: number[];
  try {
    vector = await embedder.embed(query);
  } catch {
    return [];
  }

  const results: SearchResult[] = [];
  for (const entry of index.entries) {
    if (!existsSync(entry.filePath)) continue;
    results.push({
      filePath: entry.filePath,
      score: cosineSimilarity(vector, entry.vector),
    });
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });

  return results.slice(0, topK);
}
