import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDir,
  archiveNote,
  clearPossibleDupes,
  dequeueAll,
  enqueueForIndexing,
  filesNeedingIndex,
  hashText,
  indexPath,
  indexNote,
  listMemories,
  memoryDir,
  possibleDupesPath,
  queuePath,
  readIndex,
  readNote,
  readPossibleDupes,
  readQueue,
  recordPossibleDupe,
  resolveMemoryPath,
  touchUpdated,
  updateMemory,
  writeMemory,
} from "../src/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "semantic-memory-store-"));
  process.env.SEMANTIC_MEMORY_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SEMANTIC_MEMORY_DIR;
});

function makeNoteText(id: string, created: string, content: string, tags: string[] = []): string {
  let text = `---\nid: ${id}\ncreated: ${created}\n`;
  if (tags.length > 0) {
    text += "tags:\n";
    for (const tag of tags) {
      text += `  - ${tag}\n`;
    }
  }
  text += `---\n${content}`;
  return text;
}

describe("store paths", () => {
  it("resolves paths from SEMANTIC_MEMORY_DIR at call time", () => {
    expect(memoryDir()).toBe(dir);
    expect(indexPath()).toBe(join(dir, ".index.json"));
    expect(queuePath()).toBe(join(dir, ".queue.json"));
  });
});

describe("writeMemory", () => {
  it("writes a note file with frontmatter and body", () => {
    const note = writeMemory("Hello, world.", ["preference"]);

    expect(note.id).toBeTruthy();
    expect(note.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(note.tags).toEqual(["preference"]);
    expect(note.content).toBe("Hello, world.");
    expect(note.filePath).toBe(join(dir, `${note.id}.md`));

    const raw = readFileSync(note.filePath, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain(`id: ${note.id}`);
    expect(raw).toContain(`created: ${note.created}`);
    expect(raw).toContain("tags:");
    expect(raw).toContain("  - preference");
    expect(raw).toContain("Hello, world.");
    expect(note.hash).toBe(hashText(raw));
  });

  it("omits the tags key when there are no tags", () => {
    const note = writeMemory("plain body");
    const raw = readFileSync(note.filePath, "utf8");
    expect(raw).not.toContain("tags:");
    expect(note.tags).toEqual([]);
  });

  it("produces a different hash when the content changes", () => {
    const a = writeMemory("one");
    const b = writeMemory("two");
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("listMemories", () => {
  it("parses notes back with correct content and tags", () => {
    const note = writeMemory("hello body", ["a", "b"]);
    const notes = listMemories();

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: note.id,
      filePath: note.filePath,
      created: note.created,
      tags: ["a", "b"],
      content: "hello body",
      hash: note.hash,
    });
  });

  it("sorts notes by created ascending", () => {
    writeFileSync(join(dir, "later.md"), makeNoteText("later", "2020-01-01T00:00:00.000Z", "later"));
    writeFileSync(join(dir, "earlier.md"), makeNoteText("earlier", "2019-01-01T00:00:00.000Z", "earlier"));

    const notes = listMemories();
    expect(notes.map((n) => n.id)).toEqual(["earlier", "later"]);
  });
});

describe("readNote", () => {
  it("returns undefined for a missing file", () => {
    expect(readNote(join(dir, "missing.md"))).toBeUndefined();
  });

  it("returns undefined for an unparseable file", () => {
    const filePath = join(dir, "bad.md");
    writeFileSync(filePath, "not a memory note");
    expect(readNote(filePath)).toBeUndefined();
  });
});

describe("hashText", () => {
  it("returns a sha256 hex digest", () => {
    expect(hashText("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("changes when the input changes", () => {
    expect(hashText("hello")).not.toBe(hashText("hello!"));
  });
});

describe("index", () => {
  it("indexNote upserts by filePath without duplicating entries", () => {
    const note = writeMemory("note body");
    indexNote(note, [1, 2, 3]);

    const first = readIndex();
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      filePath: note.filePath,
      hash: note.hash,
      vector: [1, 2, 3],
    });

    indexNote(note, [4, 5, 6]);
    const second = readIndex();
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.vector).toEqual([4, 5, 6]);
  });

  it("filesNeedingIndex returns only new and changed notes", () => {
    const fresh = writeMemory("fresh");
    const indexed = writeMemory("indexed");
    indexNote(indexed, [1]);

    const changed = writeMemory("changed");
    indexNote(changed, [2]);
    const changedRaw = readFileSync(changed.filePath, "utf8");
    writeFileSync(changed.filePath, `${changedRaw}\nappended`);

    const memories = listMemories();
    const needs = filesNeedingIndex(memories, readIndex());
    expect(needs.map((n) => n.filePath).sort()).toEqual(
      [fresh.filePath, changed.filePath].sort(),
    );
  });

  it("readIndex defaults when the index is missing or corrupt", () => {
    expect(readIndex()).toEqual({ version: 1, entries: [] });
    writeFileSync(indexPath(), "not json");
    expect(readIndex()).toEqual({ version: 1, entries: [] });
  });
});

describe("queue", () => {
  it("enqueueForIndexing dedupes and persists", () => {
    enqueueForIndexing("/a.md");
    enqueueForIndexing("/a.md");
    enqueueForIndexing("/b.md");

    expect(readQueue().files).toEqual(["/a.md", "/b.md"]);
  });

  it("dequeueAll returns files and clears the queue", () => {
    enqueueForIndexing("/a.md");
    enqueueForIndexing("/b.md");

    expect(dequeueAll()).toEqual(["/a.md", "/b.md"]);
    expect(readQueue().files).toEqual([]);
  });

  it("readQueue defaults when the queue is missing or corrupt", () => {
    expect(readQueue()).toEqual({ version: 1, files: [] });
    writeFileSync(queuePath(), "not json");
    expect(readQueue()).toEqual({ version: 1, files: [] });
  });
});

describe("updateMemory", () => {
  it("archives the previous version, replaces body, preserves id/created, sets updated, keeps tags when omitted", () => {
    const note = writeMemory("old body", ["a", "b"]);
    const updated = updateMemory(note.filePath, "new body");

    expect(updated).toBeDefined();
    expect(updated!.id).toBe(note.id);
    expect(updated!.created).toBe(note.created);
    expect(updated!.content).toBe("new body");
    expect(updated!.tags).toEqual(["a", "b"]);
    expect(updated!.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const reread = readNote(note.filePath);
    expect(reread!.content).toBe("new body");
    expect(reread!.updated).toBe(updated!.updated);

    const archived = readdirSync(archiveDir()).filter((f) => f.endsWith(".md"));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain(note.id);
    const archiveRaw = readFileSync(join(archiveDir(), archived[0]!), "utf8");
    expect(archiveRaw).toContain("old body");
  });

  it("replaces tags when provided (including clearing with [])", () => {
    const note = writeMemory("body", ["a"]);
    const updated = updateMemory(note.filePath, "body2", ["x", "y"]);
    expect(updated!.tags).toEqual(["x", "y"]);

    const cleared = updateMemory(note.filePath, "body3", []);
    expect(cleared!.tags).toEqual([]);
  });
});

describe("archiveNote", () => {
  it("copies the current file into .archive with a timestamped name", () => {
    const note = writeMemory("archive me", ["t"]);
    const archivePath = archiveNote(note.filePath);

    expect(archivePath).toBeDefined();
    expect(archivePath!.startsWith(archiveDir())).toBe(true);
    expect(readFileSync(archivePath!, "utf8")).toContain("archive me");
    // original unchanged
    expect(readFileSync(note.filePath, "utf8")).toContain("archive me");
  });

  it("returns undefined for a missing file", () => {
    expect(archiveNote(join(dir, "missing.md"))).toBeUndefined();
  });
});

describe("touchUpdated", () => {
  it("sets updated and syncs the index hash while keeping the vector", () => {
    const note = writeMemory("body", ["tag"]);
    indexNote(note, [1, 2, 3]);
    const before = readIndex().entries[0]!;

    const touched = touchUpdated(note.filePath);
    expect(touched!.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = readIndex().entries[0]!;
    expect(after.vector).toEqual([1, 2, 3]);
    expect(after.hash).toBe(touched!.hash);
    expect(after.hash).not.toBe(before.hash);

    // a timestamp touch must not mark the note as needing re-embed
    expect(filesNeedingIndex(listMemories(), readIndex())).toEqual([]);
  });
});

describe("resolveMemoryPath", () => {
  it("accepts a direct .md by bare name and absolute path", () => {
    const note = writeMemory("body");
    expect(resolveMemoryPath(`${note.id}.md`)).toBe(note.filePath);
    expect(resolveMemoryPath(note.filePath)).toBe(note.filePath);
  });

  it("rejects traversal, non-md, and archive paths", () => {
    const note = writeMemory("body");
    expect(resolveMemoryPath("../escape.md")).toBeUndefined();

    writeFileSync(join(dir, "note.txt"), "x");
    expect(resolveMemoryPath(join(dir, "note.txt"))).toBeUndefined();

    archiveNote(note.filePath);
    const archived = readdirSync(archiveDir()).filter((f) => f.endsWith(".md"))[0]!;
    expect(resolveMemoryPath(join(archiveDir(), archived))).toBeUndefined();
  });

  it("rejects a symlink escaping the directory", () => {
    const outside = join(tmpdir(), `outside-${Date.now()}.md`);
    writeFileSync(outside, "---\nid: x\ncreated: 2020-01-01T00:00:00.000Z\n---\nx");
    const link = join(dir, "escape.md");
    symlinkSync(outside, link);

    expect(resolveMemoryPath(link)).toBeUndefined();
    rmSync(outside, { force: true });
  });
});

describe("possible dupes", () => {
  it("round-trips record/read/clear and defaults when corrupt", () => {
    expect(readPossibleDupes()).toEqual({ version: 1, entries: [] });

    recordPossibleDupe({
      filePath: "/a.md",
      at: "2020-01-01T00:00:00.000Z",
      candidates: [{ filePath: "/b.md", score: 0.9 }],
    });

    const p = readPossibleDupes();
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]!.candidates[0]).toEqual({ filePath: "/b.md", score: 0.9 });

    clearPossibleDupes();
    expect(readPossibleDupes().entries).toHaveLength(0);

    writeFileSync(possibleDupesPath(), "not json");
    expect(readPossibleDupes()).toEqual({ version: 1, entries: [] });
  });
});
