/**
 * Filesystem store for memory notes, the index, and the pending queue.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface MemoryNote {
  id: string;
  filePath: string;
  created: string;
  tags: string[];
  content: string;
  hash: string;
}

export interface IndexEntry {
  filePath: string;
  vector: number[];
  hash: string;
}

export interface MemoryIndex {
  version: 1;
  entries: IndexEntry[];
}

export interface IndexQueue {
  version: 1;
  files: string[];
}

export function memoryDir(): string {
  const override = process.env.SEMANTIC_MEMORY_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".pi", "agent", "memory");
}

export function indexPath(): string {
  return path.join(memoryDir(), ".index.json");
}

export function queuePath(): string {
  return path.join(memoryDir(), ".queue.json");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ensureMemoryDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Trim leading blank lines only; preserve everything else. */
function trimLeadingBlankLines(text: string): string {
  return text.replace(/^\n+/, "");
}

function serializeNote(id: string, created: string, tags: string[], body: string): string {
  let text = `---\nid: ${id}\ncreated: ${created}\n`;
  if (tags.length > 0) {
    text += "tags:\n";
    for (const tag of tags) {
      text += `  - ${tag}\n`;
    }
  }
  text += `---\n${body}`;
  return text;
}

function parseNoteText(filePath: string, text: string): MemoryNote | undefined {
  const lines = text.split("\n");
  if (lines[0] !== "---") return undefined;

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) return undefined;

  const frontmatter = lines.slice(1, closingIndex);
  let id: string | undefined;
  let created: string | undefined;
  const tags: string[] = [];

  let i = 0;
  while (i < frontmatter.length) {
    const line = frontmatter[i] ?? "";
    const idMatch = /^id:\s*(.*)$/.exec(line);
    if (idMatch) {
      id = idMatch[1]!.trim();
      i += 1;
      continue;
    }

    const createdMatch = /^created:\s*(.*)$/.exec(line);
    if (createdMatch) {
      created = createdMatch[1]!.trim();
      i += 1;
      continue;
    }

    if (line === "tags:") {
      i += 1;
      while (i < frontmatter.length) {
        const tagMatch = /^  - (.*)$/.exec(frontmatter[i] ?? "");
        if (!tagMatch) break;
        tags.push(tagMatch[1]!.trim());
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  if (created === undefined) return undefined;

  const stem = path.parse(filePath).name;
  if (id !== undefined && id !== stem) return undefined;

  const body = trimLeadingBlankLines(lines.slice(closingIndex + 1).join("\n"));

  return {
    id: stem,
    filePath,
    created,
    tags,
    content: body,
    hash: hashText(text),
  };
}

export function writeMemory(content: string, tags: string[] = []): MemoryNote {
  const dir = memoryDir();
  ensureMemoryDir(dir);

  const id = randomUUID();
  const created = new Date().toISOString();
  const body = trimLeadingBlankLines(content);
  const filePath = path.join(dir, `${id}.md`);
  const text = serializeNote(id, created, tags, body);

  writeFileSync(filePath, text);

  return {
    id,
    filePath,
    created,
    tags: [...tags],
    content: body,
    hash: hashText(text),
  };
}

export function listMemories(): MemoryNote[] {
  const dir = memoryDir();
  if (!existsSync(dir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const notes: MemoryNote[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const note = readNote(filePath);
    if (note !== undefined) notes.push(note);
  }

  notes.sort((a, b) => {
    if (a.created !== b.created) return a.created < b.created ? -1 : 1;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });

  return notes;
}

export function readNote(filePath: string): MemoryNote | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return parseNoteText(filePath, text);
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.filePath !== "string") return false;
  if (typeof obj.hash !== "string") return false;
  if (!Array.isArray(obj.vector)) return false;
  return obj.vector.every((n) => typeof n === "number");
}

function isMemoryIndex(value: unknown): value is MemoryIndex {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (!Array.isArray(obj.entries)) return false;
  return obj.entries.every((entry) => isIndexEntry(entry));
}

export function readIndex(): MemoryIndex {
  let raw: string;
  try {
    raw = readFileSync(indexPath(), "utf8");
  } catch {
    return { version: 1, entries: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, entries: [] };
  }

  return isMemoryIndex(parsed) ? parsed : { version: 1, entries: [] };
}

export function writeIndex(index: MemoryIndex): void {
  const dir = memoryDir();
  ensureMemoryDir(dir);
  writeFileSync(path.join(dir, ".index.json"), JSON.stringify(index, null, 2));
}

export function upsertIndexEntry(index: MemoryIndex, entry: IndexEntry): MemoryIndex {
  const existing = index.entries.findIndex((e) => e.filePath === entry.filePath);
  if (existing === -1) {
    index.entries.push(entry);
  } else {
    index.entries[existing] = entry;
  }
  return index;
}

export function indexNote(note: MemoryNote, vector: number[]): void {
  const index = readIndex();
  upsertIndexEntry(index, { filePath: note.filePath, vector, hash: note.hash });
  writeIndex(index);
}

function isIndexQueue(value: unknown): value is IndexQueue {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (!Array.isArray(obj.files)) return false;
  return obj.files.every((file) => typeof file === "string");
}

export function readQueue(): IndexQueue {
  let raw: string;
  try {
    raw = readFileSync(queuePath(), "utf8");
  } catch {
    return { version: 1, files: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 1, files: [] };
  }

  return isIndexQueue(parsed) ? parsed : { version: 1, files: [] };
}

export function writeQueue(queue: IndexQueue): void {
  const dir = memoryDir();
  ensureMemoryDir(dir);
  writeFileSync(path.join(dir, ".queue.json"), JSON.stringify(queue, null, 2));
}

export function enqueueForIndexing(filePath: string): void {
  const queue = readQueue();
  if (!queue.files.includes(filePath)) {
    queue.files.push(filePath);
    writeQueue(queue);
  }
}

export function dequeueAll(): string[] {
  const queue = readQueue();
  const files = queue.files;
  queue.files = [];
  writeQueue(queue);
  return files;
}

export function filesNeedingIndex(memories: MemoryNote[], index: MemoryIndex): MemoryNote[] {
  const byPath = new Map(index.entries.map((entry) => [entry.filePath, entry]));
  return memories.filter((memory) => {
    const entry = byPath.get(memory.filePath);
    return entry === undefined || entry.hash !== memory.hash;
  });
}
