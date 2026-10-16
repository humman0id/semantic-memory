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

`~` resolves via `os.homedir()`. Env overrides are read at call time, not cached.

---

## 2. Note file format

A memory note is a single `.md` file `<memoryDir>/<id>.md`:

```markdown
---
id: 3f9c1e2a-...
created: 2026-10-16T10:00:00.000Z
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

export function memoryDir(): string;
export function indexPath(): string;
export function queuePath(): string;

export function hashText(text: string): string;   // sha256 hex

export function writeMemory(content: string, tags?: string[]): MemoryNote;
export function listMemories(): MemoryNote[];      // all *.md in memoryDir, sorted by created asc
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

export function cosineSimilarity(a: number[], b: number[]): number;

/** Embed the query and return the topK index entries by cosine similarity. */
export function search(
  query: string,
  topK: number,
  embedder: Embedder,
  index: MemoryIndex,
): Promise<SearchResult[]>;
```

- `search` returns **file paths and scores only** — never note contents.
- Results are sorted by score descending, then by `filePath` ascending for ties.
- Entries whose `filePath` no longer exists on disk are skipped.
- Empty index or failed embed => `[]` (do not throw).

---

## 9. `src/index.ts` (hooks — extension entry)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SaveMemoryToolResult {
  filePath: string;
  indexed: boolean;   // true when embedded + indexed now
  queued: boolean;    // true when embeddings unavailable and the note is queued
}

export interface SearchMemoryToolResult {
  results: { filePath: string; score: number }[];
}

export interface RetrievalController {
  readonly searched: boolean;
  /** First user turn returns the context block; later turns return "". */
  onUserTurn(query: string): Promise<string>;
  reset(): void;
}

export function createRetrievalController(deps: {
  search: (query: string, topK: number) => Promise<{ filePath: string; score: number }[]>;
  readNote: (filePath: string) => MemoryNote | undefined; // for short body previews
  topK?: number;           // default 5
  previewLength?: number;  // characters per preview, default 200
}): RetrievalController;

/** Testable, Pi-free core. `createMemoryToolCore` depends only on store/search/embed. */
export interface MemoryToolCoreDeps {
  embedder: Embedder;
  topK?: number;           // default 5
  previewLength?: number;  // default 200
}

export interface MemoryToolCore {
  saveMemory(content: string, tags?: string[]): Promise<SaveMemoryToolResult>;
  searchMemory(query: string, topK?: number): Promise<SearchResult[]>;
  /** Best-effort index of queued + changed files; returns counts. */
  processPending(): Promise<{ indexed: number; failed: number }>;
  preflight(): Promise<PreflightResult>;
}

export function createMemoryToolCore(deps: MemoryToolCoreDeps): MemoryToolCore;

/** Default export: the extension factory registered by Pi. */
export default function semanticMemory(pi: ExtensionAPI): void;
```

Extension behavior (verified against Pi 1.3.0, see `docs/pi-notes.md`):

1. **System prompt** — on `before_agent_start`, inject the contents of
   `prompts/memory-instructions.md` (read once at load, resolved relative to the
   extension file) as `event.systemPromptOptions.sections.memory_instructions`.
2. **Retrieval** — on `session_start`, `retrieval.reset()`. On
   `before_agent_start` with `messageType === "user"`, call
   `retrieval.onUserTurn(event.prompt)` once; if it returns a non-empty block,
   set `event.systemPromptOptions.sections.memory_retrieval = block`. This yields
   exactly one search per session.
   - The block lists top paths with short previews (truncated note bodies), and
     tells the model to open them with the `read` tool.
3. **Tools** (implemented by `createMemoryToolCore`, wired into `pi.registerTool`)
   - `save_memory(content: string, tags?: string[])`:
     `writeMemory(content, tags)` always writes the `.md`. Then attempt
     `embed(note.content)`. On success `indexNote(note, vector)` and report
     `indexed: true`. On failure `enqueueForIndexing(note.filePath)` and report
     `queued: true` with the preflight message.
   - `search_memory(query: string, topK?: number)`:
     `search(query, topK ?? 5, embedder, readIndex())`, returns paths + scores.
4. **Preflight** — on `session_start` (and before any tool that needs
   embeddings), run `preflight(embedder)`. If not ok, `ctx.ui.notify(message,
   "warning")` and keep the session alive. `save_memory` still writes + queues.
5. **Pending indexing** — on `session_start` and after a successful `embed`,
   process `dequeueAll()` plus `filesNeedingIndex(listMemories(), readIndex())`
   and `indexNote` each. This is best-effort and must not throw.

The retrieval preview format (used by `createRetrievalController`) is:

```text
Relevant long-term memory (open with the `read` tool when needed):
- /abs/path/note.md (score 0.91): first 200 chars...
- /abs/path/note2.md (score 0.80): ...
```

---

## 10. Tests

- `test/*.test.ts` — vitest. Embedder is **mocked** (no network). Memory dir is
  redirected via `SEMANTIC_MEMORY_DIR` to a temp dir.
- `scripts/check-goal.ts` additionally runs the real-Ollama integration for
  criterion 4, skipping it when the endpoint is unreachable.
