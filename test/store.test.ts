import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dequeueAll,
  enqueueForIndexing,
  filesNeedingIndex,
  hashText,
  indexPath,
  indexNote,
  listMemories,
  memoryDir,
  queuePath,
  readIndex,
  readNote,
  readQueue,
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
