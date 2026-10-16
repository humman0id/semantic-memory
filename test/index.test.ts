import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryToolCore,
  createRetrievalController,
  readInstructions,
} from "../src/index.js";
import type { Embedder } from "../src/embed.js";
import { readIndex, readNote, readQueue, writeMemory } from "../src/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "semantic-memory-index-"));
  process.env.SEMANTIC_MEMORY_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SEMANTIC_MEMORY_DIR;
});

const fixedEmbedder: Embedder = {
  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  },
};

describe("createRetrievalController", () => {
  it("searches once across two turns, then resets", async () => {
    const note = writeMemory("Alpha beta gamma delta content for preview.", ["test"]);
    const search = vi.fn(async () => [{ filePath: note.filePath, score: 0.9 }]);
    const controller = createRetrievalController({
      search,
      readNote,
      previewLength: 20,
    });

    const first = await controller.onUserTurn("hello");
    expect(search).toHaveBeenCalledTimes(1);
    expect(first).toContain(note.filePath);
    expect(first).toContain("Alpha beta");
    expect(first).toContain("score 0.900");
    expect(controller.searched).toBe(true);

    const second = await controller.onUserTurn("hello again");
    expect(second).toBe("");
    expect(search).toHaveBeenCalledTimes(1);

    controller.reset();
    expect(controller.searched).toBe(false);
    await controller.onUserTurn("third turn");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("returns an empty block when search finds nothing", async () => {
    const search = vi.fn(async () => []);
    const controller = createRetrievalController({ search, readNote });

    expect(await controller.onUserTurn("hello")).toBe("");
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe("createMemoryToolCore", () => {
  it("indexes immediately when embedding succeeds", async () => {
    const core = createMemoryToolCore({ embedder: fixedEmbedder });
    const res = await core.saveMemory("remember this", ["preference"]);

    expect(res.indexed).toBe(true);
    expect(res.queued).toBe(false);
    expect(existsSync(res.filePath)).toBe(true);

    const index = readIndex();
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      filePath: res.filePath,
      vector: [0.1, 0.2, 0.3],
    });
  });

  it("queues the note when embedding fails", async () => {
    const throwing: Embedder = {
      async embed(): Promise<number[]> {
        throw new Error("embed unavailable");
      },
    };
    const core = createMemoryToolCore({ embedder: throwing });
    const res = await core.saveMemory("remember this", []);

    expect(res.indexed).toBe(false);
    expect(res.queued).toBe(true);
    expect(existsSync(res.filePath)).toBe(true);
    expect(readQueue().files).toContain(res.filePath);
  });

  it("processPending indexes a queued file once embedding succeeds", async () => {
    const throwing: Embedder = {
      async embed(): Promise<number[]> {
        throw new Error("embed unavailable");
      },
    };
    const failing = createMemoryToolCore({ embedder: throwing });
    const res = await failing.saveMemory("pending note", []);
    expect(res.queued).toBe(true);

    const recovering = createMemoryToolCore({ embedder: fixedEmbedder });
    const outcome = await recovering.processPending();

    expect(outcome.indexed).toBe(1);
    expect(outcome.failed).toBe(0);
    expect(readIndex().entries).toHaveLength(1);
    expect(readIndex().entries[0]).toMatchObject({ filePath: res.filePath });
    expect(readQueue().files).toEqual([]);
  });
});

describe("readInstructions", () => {
  it("returns non-empty instructions mentioning the tools", () => {
    const text = readInstructions();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/save_memory|memory/);
  });
});
