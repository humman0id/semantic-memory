import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryToolCore,
  createRetrievalController,
  readInstructions,
} from "../src/index.js";
import type { Embedder } from "../src/embed.js";
import { listMemories, readIndex, readNote, readQueue, writeMemory } from "../src/store.js";

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

function mapEmbedder(vectors: Record<string, number[]>): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      return vectors[text] ?? [0, 0, 0];
    },
  };
}

describe("createRetrievalController", () => {
  it("searches once across two turns, then resets", async () => {
    const note = writeMemory("Alpha beta gamma delta content for preview.", ["test"]);
    const search = vi.fn(async () => [{ filePath: note.filePath, score: 0.9 }]);
    const controller = createRetrievalController({ search, readNote, previewLength: 20 });

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

  it("filters injected results by minScore and injects nothing when none pass", async () => {
    const search = vi.fn(async (_q: string, _k: number, minScore?: number) => {
      const all = [
        { filePath: "/tmp/a.md", score: 0.3 },
        { filePath: "/tmp/b.md", score: 0.8 },
      ];
      return all.filter((h) => h.score >= (minScore ?? 0));
    });

    const controller = createRetrievalController({ search, readNote, minScore: 0.5, topK: 5 });
    const block = await controller.onUserTurn("hi");
    expect(search).toHaveBeenCalledWith("hi", 5, 0.5);
    expect(block).toContain("/tmp/b.md");
    expect(block).not.toContain("/tmp/a.md");

    const empty = await createRetrievalController({ search: async () => [], readNote, minScore: 0.5 }).onUserTurn("x");
    expect(empty).toBe("");
  });
});

describe("createMemoryToolCore", () => {
  it("indexes immediately when embedding succeeds", async () => {
    const core = createMemoryToolCore({ embedder: fixedEmbedder });
    const res = await core.saveMemory("remember this", ["preference"]);

    expect(res.status).toBe("saved");
    expect(res.indexed).toBe(true);
    expect(res.queued).toBe(false);
    expect(existsSync(res.filePath ?? "")).toBe(true);

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

    expect(res.status).toBe("queued");
    expect(res.indexed).toBe(false);
    expect(res.queued).toBe(true);
    expect(existsSync(res.filePath ?? "")).toBe(true);
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

describe("save_memory dedupe", () => {
  it("returns duplicate for near-identical content and writes one file", async () => {
    const embedder = mapEmbedder({
      "tabs over spaces": [1, 0],
      "tabs rather than spaces": [0.99, 0.1],
    });
    const core = createMemoryToolCore({ embedder, dupScore: 0.9, similarScore: 0.6 });

    const a = await core.saveMemory("tabs over spaces", ["pref"]);
    const b = await core.saveMemory("tabs rather than spaces", ["pref"]);

    expect(a.status).toBe("saved");
    expect(b.status).toBe("duplicate");
    expect(b.filePath).toBe(a.filePath);
    expect(listMemories()).toHaveLength(1);
  });

  it("returns candidates for similar content and writes nothing unless allowNew", async () => {
    const embedder = mapEmbedder({
      "prefers npm": [1, 0],
      "prefers pnpm": [0.7, 0.7],
    });
    const core = createMemoryToolCore({ embedder, dupScore: 0.95, similarScore: 0.6 });

    const a = await core.saveMemory("prefers npm", []);
    const b = await core.saveMemory("prefers pnpm", []);

    expect(a.status).toBe("saved");
    expect(b.status).toBe("similar");
    expect(b.candidates).toHaveLength(1);
    expect(b.candidates![0]!.filePath).toBe(a.filePath);
    expect(listMemories()).toHaveLength(1);

    const c = await core.saveMemory("prefers pnpm", [], true);
    expect(c.status).toBe("saved");
    expect(listMemories()).toHaveLength(2);
  });
});

describe("update_memory", () => {
  it("replaces content, preserves id/created, sets updated, archives, and re-indexes", async () => {
    const embedder = mapEmbedder({ "old wording": [1, 0], "new wording": [0, 1] });
    const core = createMemoryToolCore({ embedder });

    const saved = await core.saveMemory("old wording", ["tag"]);
    const before = readNote(saved.filePath!);
    const upd = await core.updateMemory(saved.filePath!, "new wording", ["tag2"]);

    expect(upd.ok).toBe(true);
    expect(upd.archivePath).toBeDefined();
    expect(existsSync(upd.archivePath!)).toBe(true);
    expect(readFileSync(upd.archivePath!, "utf8")).toContain("old wording");

    const after = readNote(saved.filePath!);
    expect(after!.id).toBe(before!.id);
    expect(after!.created).toBe(before!.created);
    expect(after!.updated).toBeDefined();
    expect(after!.content).toBe("new wording");
    expect(after!.tags).toEqual(["tag2"]);

    const hits = await core.searchMemory("new wording", 5);
    expect(hits.map((h) => h.filePath)).toContain(saved.filePath);
  });

  it("rejects paths outside the directory, non-.md files, and archive paths", async () => {
    const core = createMemoryToolCore({ embedder: fixedEmbedder });
    const saved = await core.saveMemory("body", []);

    expect((await core.updateMemory(join(dir, "..", "escape.md"), "x")).ok).toBe(false);

    const txt = join(dir, "note.txt");
    writeFileSync(txt, "x");
    expect((await core.updateMemory(txt, "x")).ok).toBe(false);

    const archived = await core.updateMemory(saved.filePath!, "body2", []);
    expect(archived.ok).toBe(true);
    expect((await core.updateMemory(archived.archivePath!, "x")).ok).toBe(false);
  });
});

describe("search_memory minScore", () => {
  it("returns scored results and honors an explicit minScore", async () => {
    const embedder = mapEmbedder({ query: [1, 0], one: [1, 0], two: [0, 1] });
    const core = createMemoryToolCore({ embedder });
    await core.saveMemory("one", []);
    await core.saveMemory("two", []);

    const all = await core.searchMemory("query", 10);
    expect(all).toHaveLength(2);
    for (const hit of all) expect(typeof hit.score).toBe("number");

    const filtered = await core.searchMemory("query", 10, 0.9);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.score).toBeGreaterThanOrEqual(0.9);
  });
});

describe("processPending possible duplicates", () => {
  it("records possible dupes instead of deleting when a queued note matches an existing note", async () => {
    const embedder = mapEmbedder({
      "fact one": [1, 0],
      "fact one reworded": [0.9, 0.4],
    });
    const good = createMemoryToolCore({ embedder, similarScore: 0.6 });
    await good.saveMemory("fact one", []);

    const down: Embedder = {
      async embed(): Promise<number[]> {
        throw new Error("down");
      },
    };
    const queued = await createMemoryToolCore({ embedder: down }).saveMemory("fact one reworded", []);
    expect(queued.status).toBe("queued");

    const recovered = createMemoryToolCore({ embedder, similarScore: 0.6 });
    const outcome = await recovered.processPending();

    expect(outcome.possibleDupes).toBe(1);
    expect(outcome.indexed).toBe(0);
    expect(existsSync(queued.filePath!)).toBe(true); // not deleted
    expect(readIndex().entries).toHaveLength(1); // not indexed/merged

    const dupes = recovered.getPossibleDupes();
    expect(dupes.entries).toHaveLength(1);
    expect(dupes.entries[0]!.filePath).toBe(queued.filePath);
    expect(dupes.entries[0]!.candidates.length).toBeGreaterThan(0);
  });
});

describe("readInstructions", () => {
  it("returns non-empty instructions mentioning the tools", () => {
    const text = readInstructions();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/save_memory|memory/);
  });
});
