import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosineSimilarity, search } from "../src/search.js";
import type { Embedder } from "../src/embed.js";
import type { MemoryIndex } from "../src/store.js";

let dir: string;
let noteA: string;
let noteB: string;
let missing: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "semantic-memory-search-"));
  noteA = join(dir, "a.md");
  noteB = join(dir, "b.md");
  missing = join(dir, "missing.md");
  writeFileSync(noteA, "---\nid: a\ncreated: 2020-01-01T00:00:00.000Z\n---\nA");
  writeFileSync(noteB, "---\nid: b\ncreated: 2020-01-01T00:00:00.000Z\n---\nB");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const embedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    if (text === "query") return [1, 0];
    if (text === "noteA") return [1, 0];
    if (text === "noteB") return [0, 1];
    return [0, 0];
  },
};

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for a zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 when lengths differ", () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});

describe("search", () => {
  it("returns the expected top path by cosine similarity", async () => {
    const index: MemoryIndex = {
      version: 1,
      entries: [
        { filePath: noteB, vector: [0, 1], hash: "b" },
        { filePath: noteA, vector: [1, 0], hash: "a" },
      ],
    };

    const results = await search("query", 1, embedder, index);
    expect(results).toEqual([{ filePath: noteA, score: 1 }]);
  });

  it("sorts ties by filePath ascending", async () => {
    const sameScore: Embedder = {
      async embed(): Promise<number[]> {
        return [1, 0];
      },
    };
    const index: MemoryIndex = {
      version: 1,
      entries: [
        { filePath: noteB, vector: [0.5, 0], hash: "b" },
        { filePath: noteA, vector: [1, 0], hash: "a" },
      ],
    };

    const results = await search("query", 10, sameScore, index);
    expect(results.map((r) => r.filePath)).toEqual([noteA, noteB]);
  });

  it("skips entries whose file no longer exists", async () => {
    const index: MemoryIndex = {
      version: 1,
      entries: [
        { filePath: missing, vector: [1, 0], hash: "missing" },
        { filePath: noteB, vector: [0, 1], hash: "b" },
      ],
    };

    const results = await search("query", 10, embedder, index);
    expect(results).toEqual([{ filePath: noteB, score: 0 }]);
  });

  it("returns [] when embed throws", async () => {
    const throwing: Embedder = {
      async embed(): Promise<number[]> {
        throw new Error("boom");
      },
    };
    const index: MemoryIndex = {
      version: 1,
      entries: [{ filePath: noteA, vector: [1, 0], hash: "a" }],
    };

    expect(await search("query", 10, throwing, index)).toEqual([]);
  });

  it("returns [] on an empty index", async () => {
    expect(await search("query", 10, embedder, { version: 1, entries: [] })).toEqual([]);
  });
});
