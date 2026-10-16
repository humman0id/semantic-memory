#!/usr/bin/env node
/**
 * find-duplicates.ts — READ-ONLY scan of a memory directory. Prints candidate
 * duplicate/similar note pairs with cosine scores. Never writes anything.
 *
 * Usage: npx tsx scripts/find-duplicates.ts [memoryDir]
 * Defaults to $SEMANTIC_MEMORY_DIR or ~/.pi/agent/memory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOllamaEmbedder, probeEmbedder } from "../src/embed.js";
import { cosineSimilarity } from "../src/search.js";
import { listMemories } from "../src/store.js";

const dirArg = process.argv[2];
const resolvedDir = dirArg
  ? path.resolve(dirArg)
  : process.env.SEMANTIC_MEMORY_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent", "memory");

// Point store at the requested dir (store reads env at call time). This script
// is read-only: it only calls listMemories(), never write/queue/index.
process.env.SEMANTIC_MEMORY_DIR = resolvedDir;

const threshold = Number(process.env.SEMANTIC_MEMORY_SIMILAR_SCORE ?? "0.62");

async function main(): Promise<void> {
  const embedder = createOllamaEmbedder();
  const status = await probeEmbedder(embedder);
  if (!status.available) {
    console.error(`Ollama unavailable: ${status.error ?? "unknown error"}`);
    process.exit(2);
  }

  const notes = listMemories();
  console.log(`Scanning ${resolvedDir} — ${notes.length} note(s), threshold=${threshold} (read-only)`);

  if (notes.length < 2) {
    console.log("Too few notes to compare.");
    return;
  }

  // Embed each note once.
  const vectors = new Map<string, number[]>();
  for (const note of notes) {
    vectors.set(note.filePath, await embedder.embed(note.content));
  }

  const pairs: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const a = notes[i]!;
      const b = notes[j]!;
      const score = cosineSimilarity(vectors.get(a.filePath)!, vectors.get(b.filePath)!);
      if (score >= threshold) {
        pairs.push({ a: a.filePath, b: b.filePath, score });
      }
    }
  }

  pairs.sort((x, y) => y.score - x.score);

  if (pairs.length === 0) {
    console.log(`No pairs at or above ${threshold}.`);
    return;
  }

  for (const p of pairs) {
    console.log(`${p.score.toFixed(3)}  ${p.a}\n        <-> ${p.b}`);
  }
}

main().catch((err) => {
  console.error("find-duplicates crashed:", err);
  process.exit(1);
});
