# Contracts

Module signatures and data formats for `semantic_memory`. All subagents code
against this file. If it is wrong or missing, stop and report back — do not edit
it or work around it.

All paths are absolute unless noted. All modules are ESM TypeScript.

---

## 1. Directories and files

| Name | Path | Purpose |
|---|---|---|
| Memory dir | `~/.pi/agent/memory/` (override: env `SEMANTIC_MEMORY_DIR`) | raw `.md` notes |
| Index | `<memoryDir>/.index.json` | `{filePath, vector, hash}` per embedded note |
| Queue | `<memoryDir>/.queue.json` | note paths awaiting indexing |
| Archive | `<memoryDir>/.archive/` | previous versions of updated notes (excluded from index/search) |
| Possible dupes | `<memoryDir>/.possible-dupes.json` | near-duplicate candidates found during queue processing |

`~` resolves via `os.homedir()`. Env overrides are read at call time, not cached.

---

## 2. Note file format

A memory note is a single `.md` file `<memoryDir>/<id>.md`:

```markdown
---
id: 3f9c1e2a-...
created: 2026-10-16T10:00:00.000Z
updated: 2026-10-16T11:00:00.000Z
tags:
  - preference
  - style
---
The note body. Self-contained, one topic.
```

Rules:

- First line is exactly `---`; the frontmatter block ends at the next line that
  is exactly `---`.
- `id` — a UUID string (the filename stem, no `.md`).
- `created` — ISO-8601 UTC string.
- `updated` — optional ISO-8601 UTC string; set/refreshed when the note is
  updated or touched as a duplicate. Written after `created`, before `tags`.
- `tags` — a YAML list. Each tag is a line `  - <tag>` (two-space indent).
  Omit the `tags:` key entirely when there are no tags.
- The body is everything after the closing `---`, with leading blank lines
  trimmed; content is preserved otherwise.

---

## 3. Index format

`<memoryDir>/.index.json`:

```json
{
  "version": 1,
  "entries": [
    { "filePath": "/abs/path/3f9c1e2a.md", "vector": [0.1, 0.2], "hash": "<sha256 hex>" }
  ]
}
```

- `hash` is the sha256 hex of the **entire raw file text** (frontmatter + body),
  so any change to a note invalidates its embedding.

---

## 4. Queue format

`<memoryDir>/.queue.json`:

```json
{ "version": 1, "files": ["/abs/path/note.md"] }
```

`files` is a list of absolute note paths that still need indexing. Duplicates
are removed on enqueue. `dequeueAll()` returns the list and clears the queue.

---

## 4a. Possible-dupes format

`<memoryDir>/.possible-dupes.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "filePath": "/abs/path/queued.md",
      "at": "2026-10-16T12:00:00.000Z",
      "candidates": [ { "filePath": "/abs/path/older.md", "score": 0.83 } ]
    }
  ]
}
```

Written during queue processing when a queued note is a near-duplicate or
similar to an existing note. The note is left on disk and **not** indexed.
`session_start` reads this once, notifies the model, then clears it.

---

## 5. `src/embed.ts`

```ts
export interface Embedder {
  /** Embed one text into a numeric vector. Throws on failure. */
  embed(text: string): Promise<number[]>;
}

export interface EmbedderStatus {
  available: boolean;
  error?: string;        // set when !available
}

export interface OllamaEmbedderOptions {
  baseUrl?: string;      // default: env SEMANTIC_MEMORY_EMBED_URL or "http://localhost:11434"
  model?: string;        // default: env SEMANTIC_MEMORY_EMBED_MODEL or "embeddinggemma"
  fetch?: typeof fetch;  // injectable for tests
}

/** OpenAI-compatible embedder against Ollama's /api/embed. */
export function createOllamaEmbedder(options?: OllamaEmbedderOptions): Embedder;

/** Probe the embedder with a tiny request. Never throws. */
export function probeEmbedder(embedder: Embedder): Promise<EmbedderStatus>;
```

`createOllamaEmbedder().embed(text)` POSTs to
`{baseUrl}/api/embed` with `{ model, input: text }` and returns
`json.embeddings[0]` as `number[]`. Both `embed` and `probeEmbedder` must bound
their HTTP request with a timeout (suggest ~2s) so preflight never hangs.

---

## 6. `src/preflight.ts`

```ts
export interface PreflightResult {
  ok: boolean;
  message?: string;   // clear user-facing message when !ok
}

/** Human message shown when the endpoint/model is unavailable. */
export function buildPreflightMessage(reason: string): string;
// => "Memory embeddings unavailable: <reason>. Run `ollama pull embeddinggemma`."

export function preflight(embedder: Embedder): Promise<PreflightResult>;
```

`preflight` uses `probeEmbedder`. It must never throw and must never crash the
session.

---

## 7. `src/store.ts`

```ts
export interface MemoryNote {
  id: string;        // filename stem
  filePath: string;  // absolute path
  created: string;   // ISO-8601 UTC
  updated?: string;  // ISO-8601 UTC, set on update/touch
  tags: string[];
  content: string;   // body text (frontmatter removed)
  hash: string;      // sha256 hex of the entire raw file text
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

export interface PossibleDupeCandidate {
  filePath: string;
  score: number;
}

export interface PossibleDupeEntry {
  filePath: string;    // the note being checked (usually a queued file)
  at: string;          // ISO-8601 UTC
  candidates: PossibleDupeCandidate[];
}

export interface PossibleDupes {
  version: 1;
  entries: PossibleDupeEntry[];
}

export function memoryDir(): string;
export function indexPath(): string;
export function queuePath(): string;

export function hashText(text: string): string;   // sha256 hex

export function writeMemory(content: string, tags?: string[]): MemoryNote;
export function listMemories(): MemoryNote[];      // direct *.md children of memoryDir (excludes .archive/), sorted by created asc
export function readNote(filePath: string): MemoryNote | undefined; // parse one file, or undefined if missing

export function readIndex(): MemoryIndex;          // missing/corrupt => { version: 1, entries: [] }
export function writeIndex(index: MemoryIndex): void;
export function upsertIndexEntry(index: MemoryIndex, entry: IndexEntry): MemoryIndex;
export function indexNote(note: MemoryNote, vector: number[]): void; // read, upsert, write

export function readQueue(): IndexQueue;           // missing/corrupt => { version: 1, files: [] }
export function writeQueue(queue: IndexQueue): void;
export function enqueueForIndexing(filePath: string): void;  // dedupe + persist
export function dequeueAll(): string[];            // return files, then clear queue

/** Notes whose filePath is absent from the index or whose hash changed. */
export function filesNeedingIndex(memories: MemoryNote[], index: MemoryIndex): MemoryNote[];

export function archiveDir(): string;    // <memoryDir>/.archive
export function possibleDupesPath(): string; // <memoryDir>/.possible-dupes.json

/** Copy the current file to .archive/<id>-<timestamp>.md; return archive path (undefined if missing). */
export function archiveNote(filePath: string): string | undefined;

/** Replace body, keep id/created, set updated=now; tags omitted => keep existing. Recomputes hash. Does NOT archive or re-embed (the caller archives + embeds). */
export function updateMemory(filePath: string, content: string, tags?: string[]): MemoryNote | undefined;

/** Set/refresh `updated` only; rewrite file AND sync the index entry's hash (keep vector). */
export function touchUpdated(filePath: string): MemoryNote | undefined;

/** Canonicalize a user-supplied path for update_memory: resolve relative to memoryDir, realpath both for validation, require a DIRECT child of memoryDir ending in .md. Rejects traversal, symlink escape, non-.md, and anything under .archive/. Returns the normalized absolute path (path.resolve) or undefined. */
export function resolveMemoryPath(input: string): string | undefined;

export function readPossibleDupes(): PossibleDupes;       // missing/corrupt => { version: 1, entries: [] }
export function writePossibleDupes(p: PossibleDupes): void;
export function recordPossibleDupe(entry: PossibleDupeEntry): void;  // append + persist
export function clearPossibleDupes(): void;               // reset to empty + persist
```

Concurrency note: `readIndex`/`writeIndex` and `readQueue`/`writeQueue` are
non-atomic. The caller (hooks) must serialize read-modify-write sequences with a
mutex or Pi's `withFileMutationQueue()`. Pure functions here do not lock.

---

## 8. `src/search.ts`

```ts
import type { Embedder } from "./embed.ts";
import type { MemoryIndex } from "./store.ts";

export interface SearchResult {
  filePath: string;   // absolute path
  score: number;      // cosine similarity in [-1, 1]
}

export interface SearchOptions {
  minScore?: number;  // inclusive lower bound; entries below it are dropped
}

export function cosineSimilarity(a: number[], b: number[]): number;

/** Compare one vector against the index (no embedding). Returns topK results. */
export function searchVector(
  vector: number[],
  topK: number,
  index: MemoryIndex,
  options?: SearchOptions,
): SearchResult[];

/** Embed the query, then searchVector over the index. */
export function search(
  query: string,
  topK: number,
  embedder: Embedder,
  index: MemoryIndex,
  options?: SearchOptions,
): Promise<SearchResult[]>;
```

- Both return **file paths and scores only** — never note contents.
- Results sorted by score descending, then `filePath` ascending for ties.
- Entries whose `filePath` no longer exists on disk are skipped.
- `searchVector` with empty vector or empty index => `[]`; `search` with failed
  embed or empty index => `[]` (neither throws).
- `minScore` filters by `score >= minScore` before top-K slicing.

---

## 9. `src/index.ts` (hooks — extension entry)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SaveMemoryStatus = "saved" | "queued" | "duplicate" | "similar";

export interface SaveCandidate {
  filePath: string;
  score: number;
  preview: string;              // short note-body preview
}

export interface SaveMemoryToolResult {
  status: SaveMemoryStatus;
  filePath?: string;            // "saved"/"queued": new note; "duplicate": existing note
  indexed: boolean;
  queued: boolean;
  score?: number;               // top note-to-note cosine (duplicate/similar)
  preview?: string;             // existing note's body preview (duplicate)
  candidates?: SaveCandidate[]; // 1-3, for "similar"
}

export interface UpdateMemoryToolResult {
  ok: boolean;
  filePath?: string;            // updated note path
  archivePath?: string;         // previous version in .archive/
  error?: string;               // when ok=false
}

export interface SearchMemoryToolResult {
  results: { filePath: string; score: number }[];
}

export interface RetrievalController {
  readonly searched: boolean;
  onUserTurn(query: string): Promise<string>;
  reset(): void;
}

export function createRetrievalController(deps: {
  search: (query: string, topK: number, minScore?: number) => Promise<{ filePath: string; score: number }[]>;
  readNote: (filePath: string) => MemoryNote | undefined;
  topK?: number;            // default 5
  previewLength?: number;   // default 200
  minScore?: number;        // default env SEMANTIC_MEMORY_MIN_SCORE or 0.44
}): RetrievalController;

export interface MemoryToolCoreDeps {
  embedder: Embedder;
  topK?: number;            // default 5
  previewLength?: number;   // default 200
  dupScore?: number;        // default env SEMANTIC_MEMORY_DUP_SCORE or 0.97
  similarScore?: number;    // default env SEMANTIC_MEMORY_SIMILAR_SCORE or 0.59
  minScore?: number;        // default env SEMANTIC_MEMORY_MIN_SCORE or 0.44
}

export interface MemoryToolCore {
  saveMemory(content: string, tags?: string[], allowNew?: boolean): Promise<SaveMemoryToolResult>;
  updateMemory(filePath: string, content: string, tags?: string[]): Promise<UpdateMemoryToolResult>;
  searchMemory(query: string, topK?: number, minScore?: number): Promise<SearchResult[]>;
  processPending(): Promise<{ indexed: number; failed: number; possibleDupes: number }>;
  preflight(): Promise<PreflightResult>;
  getPossibleDupes(): PossibleDupes;
  clearPossibleDupes(): void;
}

export function createMemoryToolCore(deps: MemoryToolCoreDeps): MemoryToolCore;

/** Default export: the extension factory registered by Pi. */
export default function semanticMemory(pi: ExtensionAPI): void;
```

Extension behavior (verified against Pi 1.3.0, see `docs/pi-notes.md`):

Env vars (read at call time; defaults from `docs/decisions.md`):

| Var | Default | Use |
|---|---|---|
| `SEMANTIC_MEMORY_DUP_SCORE` | `0.97` | note→note: at/above => duplicate |
| `SEMANTIC_MEMORY_SIMILAR_SCORE` | `0.59` | note→note: at/above => similar |
| `SEMANTIC_MEMORY_MIN_SCORE` | `0.44` | query→note: injection floor |

1. **System prompt** — on `before_agent_start`, inject the contents of
   `prompts/memory-instructions.md` (read once at load, resolved relative to the
   extension file) as `event.systemPromptOptions.sections.memory_instructions`.
2. **Retrieval** — on `session_start`, `retrieval.reset()`. On
   `before_agent_start` with `messageType === "user"`, `await
   retrieval.onUserTurn(event.prompt)` once; if non-empty, set
   `sections.memory_retrieval`. `onUserTurn` searches with `minScore` and returns
   `""` (no section) when nothing passes the floor.
3. **`save_memory(content, tags?, allowNew?)`** — inside the index mutex:
   1. Try `embedder.embed(content)`. On throw → fall back: `writeMemory` +
      `enqueueForIndexing` and return
      `{status:"queued", filePath, indexed:false, queued:true}`.
   2. `top = searchVector(vector, 1, readIndex())[0]`.
   3. If `top && top.score >= dupScore` → return
      `{status:"duplicate", filePath:top.filePath, score, preview, indexed:false, queued:false}`
      and render the `update_memory` instruction alongside the preview. Refresh
      `updated` (`touchUpdated`) only when the new content is byte-identical to
      the existing note's body; a merely-similar match must not touch it.
   4. Else if `top && top.score >= similarScore && !allowNew` → return
      `{status:"similar", score, candidates: top 1-3 (path/score/preview), indexed:false, queued:false}`.
   5. Else `writeMemory` + `indexNote`, return
      `{status:"saved", filePath, indexed:true, queued:false}`.
4. **`update_memory(file_path, content, tags?)`** — `resolveMemoryPath(file_path)`;
   if `undefined` return `{ok:false, error}`. Else `updateMemory(filePath,
   content, tags)` (archives first), then `embedder.embed(content)` and
   `indexNote(note, vector)`; on embed failure `enqueueForIndexing(filePath)` and
   return `{ok:true, filePath}` with the note queued.
5. **`search_memory(query, topK?, minScore?)`** — `search(query, topK ?? 5,
   embedder, readIndex(), {minScore})`; returns paths + scores (scores always
   included).
6. **Preflight** — on `session_start` run `preflight(embedder)`; if !ok
   `ctx.ui.notify(message, "warning")`; never crash. `save_memory` still
   writes + queues.
7. **Pending indexing** — on `session_start` and after a successful embed, run
   `processPending()`. For each queued/changed note: embed, then run the same
   dedupe check against the index; if near-dup/similar, `recordPossibleDupe(...)`
   and **do not index/delete/merge** (leave the file on disk); else `indexNote`.
   Returns `{indexed, failed, possibleDupes}`.
8. **Possible-dupes notification** — on `session_start`, after `processPending()`,
   read `getPossibleDupes()`; if non-empty, notify the model once with a one-line
   summary, then `clearPossibleDupes()`.

The retrieval preview format (used by `createRetrievalController`) is:

```text
Relevant long-term memory (open with the `read` tool when needed):
- /abs/path/note.md (score 0.91): first 200 chars...
```

---

## 10. Tests

- `test/*.test.ts` — vitest. Embedder is **mocked** (no network). Memory dir is
  redirected via `SEMANTIC_MEMORY_DIR` to a temp dir.
- `scripts/check-goal.ts` additionally runs the real-Ollama integration for
  criterion 4, skipping it when the endpoint is unreachable.
