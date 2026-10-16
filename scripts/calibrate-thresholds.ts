#!/usr/bin/env node
/**
 * calibrate-thresholds.ts — measure cosine-similarity distributions against the
 * real embedding model and propose defaults for the memory-hygiene thresholds.
 *
 * Run: npx tsx scripts/calibrate-thresholds.ts
 * Exits 2 if the embedding endpoint/model is unavailable.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOllamaEmbedder, probeEmbedder } from "../src/embed.js";
import { cosineSimilarity } from "../src/search.js";

// Safety: calibrate against a throwaway dir, never the real memory directory.
const calibDir = mkdtempSync(path.join(tmpdir(), "semantic-memory-calib-"));
process.env.SEMANTIC_MEMORY_DIR = calibDir;

type Pair = [string, string];

const DUPLICATES: Pair[] = [
  ["The user prefers tabs over spaces for indentation.", "For code indentation, the user uses tabs rather than spaces."],
  ["The project uses Vitest as its test runner.", "Unit tests in this project are run with Vitest."],
  ["Deployment targets a single Node.js server.", "The app is deployed to one Node server."],
  ["The user's preferred package manager is pnpm.", "For package management, the user chooses pnpm."],
  ["The build command is npm run build.", "Run npm run build to compile the project."],
  ["The database is PostgreSQL.", "The project stores data in Postgres."],
  ["CI runs on GitHub Actions.", "GitHub Actions is the CI platform used here."],
  ["The server listens on port 3000.", "Port 3000 is where the server listens."],
  ["The user prefers two-space indentation in JSON.", "JSON files use two spaces for indentation."],
];

const SAME_TOPIC: Pair[] = [
  ["The user prefers npm as the package manager.", "The user prefers pnpm as the package manager."],
  ["Deployment targets a single Node.js server.", "Deployment targets a serverless platform."],
  ["The user prefers tabs for indentation.", "The user prefers four spaces for indentation."],
  ["The project uses Vitest for testing.", "The project uses Jest for testing."],
  ["Linting is done with ESLint.", "Linting is done with Biome."],
  ["The backend is written in TypeScript.", "The backend is written in Go."],
  ["The frontend uses React.", "The frontend uses Vue."],
  ["The user prefers dark mode.", "The user prefers light mode."],
  ["The rate limit is 100 requests per minute.", "The rate limit is 500 requests per minute."],
];

const UNRELATED: Pair[] = [
  ["The user prefers tabs for indentation.", "The user's favorite color is blue."],
  ["The project uses Vitest for testing.", "The office coffee machine is on the third floor."],
  ["Deployment targets a Node server.", "Tomorrow's weather forecast calls for rain."],
  ["The user prefers pnpm.", "The team's standup is at 9am."],
];

const QUERY_NOTE_RELEVANT: Pair[] = [
  ["How does the user like their code formatted?", "The user prefers tabs over spaces for indentation."],
  ["Which test framework does this project use?", "The project uses Vitest as its test runner."],
  ["How is the app deployed?", "Deployment targets a single Node.js server."],
  ["Which package manager does the user prefer?", "The user's preferred package manager is pnpm."],
];

const QUERY_NOTE_IRRELEVANT: Pair[] = [
  ["What's for dinner tonight?", "The user prefers tabs over spaces for indentation."],
  ["How do I configure my email client?", "The project uses Vitest as its test runner."],
  ["What's the capital of France?", "Deployment targets a single Node.js server."],
  ["Recommend a good hiking trail.", "The user's preferred package manager is pnpm."],
];

const DUP_MARGIN = 0.03;

function stats(scores: number[]): { min: number; max: number; mean: number; median: number } {
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { min: sorted[0]!, max: sorted[sorted.length - 1]!, mean, median };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  const embedder = createOllamaEmbedder();
  const status = await probeEmbedder(embedder);
  if (!status.available) {
    console.error(`Ollama unavailable: ${status.error ?? "unknown error"}`);
    process.exit(2);
  }

  const cache = new Map<string, number[]>();
  const embed = async (text: string): Promise<number[]> => {
    let v = cache.get(text);
    if (!v) {
      v = await embedder.embed(text);
      cache.set(text, v);
    }
    return v;
  };

  const classScores = async (pairs: Pair[]): Promise<number[]> => {
    const out: number[] = [];
    for (const [a, b] of pairs) {
      out.push(cosineSimilarity(await embed(a), await embed(b)));
    }
    return out;
  };

  const dup = await classScores(DUPLICATES);
  const same = await classScores(SAME_TOPIC);
  const unrel = await classScores(UNRELATED);
  const rel = await classScores(QUERY_NOTE_RELEVANT);
  const irrel = await classScores(QUERY_NOTE_IRRELEVANT);

  const report = (label: string, scores: number[]) => {
    const s = stats(scores);
    console.log(`\n## ${label} (n=${scores.length})`);
    console.log(`  scores: ${scores.map((x) => x.toFixed(3)).join(", ")}`);
    console.log(`  min=${s.min.toFixed(3)} max=${s.max.toFixed(3)} mean=${s.mean.toFixed(3)} median=${s.median.toFixed(3)}`);
    return s;
  };

  report("note/note — true duplicates (reworded)", dup);
  const sameS = report("note/note — same topic, different/contradicting fact", same);
  const unrelS = report("note/note — unrelated", unrel);
  const relS = report("query/note — relevant first message", rel);
  const irrelS = report("query/note — irrelevant first message", irrel);

  // DUP_SCORE must sit clearly ABOVE every same-topic/contradiction pair, so a
  // contradiction is never auto-deduped as a "duplicate". SIMILAR/MIN are the
  // midpoints of the clean gaps between adjacent classes.
  const maxChange = sameS.max;
  const dupScore = Math.min(0.99, round2(maxChange + DUP_MARGIN));
  const similarScore = sameS.min > unrelS.max ? round2(unrelS.max + (sameS.min - unrelS.max) * 0.5) : round2(unrelS.max);
  const minScore = relS.min > irrelS.max ? round2(irrelS.max + (relS.min - irrelS.max) * 0.5) : round2(irrelS.max);

  console.log(`\n## Calibration summary (embedding model: embeddinggemma)`);
  console.log(`  max change/contradiction score: ${maxChange.toFixed(3)}`);
  console.log(`  chosen DUP margin: ${DUP_MARGIN}`);
  console.log(`  SEMANTIC_MEMORY_DUP_SCORE=${dupScore}`);
  console.log(`  SEMANTIC_MEMORY_SIMILAR_SCORE=${similarScore}`);
  console.log(`  SEMANTIC_MEMORY_MIN_SCORE=${minScore}`);

  rmSync(calibDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("calibration crashed:", err);
  rmSync(calibDir, { recursive: true, force: true });
  process.exit(1);
});
