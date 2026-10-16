/**
 * Extension entry point: tool registration, session-start preflight, and
 * first-message retrieval injection.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createOllamaEmbedder, type Embedder } from "./embed.js";
import { preflight as runPreflight, type PreflightResult } from "./preflight.js";
import { search, type SearchResult } from "./search.js";
import {
  dequeueAll,
  enqueueForIndexing,
  filesNeedingIndex,
  indexNote,
  listMemories,
  readIndex,
  readNote,
  writeMemory,
  type MemoryNote,
} from "./store.js";

export interface SaveMemoryToolResult {
  filePath: string;
  indexed: boolean;
  queued: boolean;
}

export interface SearchMemoryToolResult {
  results: { filePath: string; score: number }[];
}

export interface RetrievalController {
  readonly searched: boolean;
  onUserTurn(query: string): Promise<string>;
  reset(): void;
}

export interface MemoryToolCoreDeps {
  embedder: Embedder;
  topK?: number;
  previewLength?: number;
}

export interface MemoryToolCore {
  saveMemory(content: string, tags?: string[]): Promise<SaveMemoryToolResult>;
  searchMemory(query: string, topK?: number): Promise<SearchResult[]>;
  processPending(): Promise<{ indexed: number; failed: number }>;
  preflight(): Promise<PreflightResult>;
}

const RETRIEVAL_HEADER =
  "Relevant long-term memory (open with the `read` tool when needed):";

/** Serialize read-modify-write sequences so concurrent calls don't corrupt the index. */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(() => fn());
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function createRetrievalController(deps: {
  search: (query: string, topK: number) => Promise<{ filePath: string; score: number }[]>;
  readNote: (filePath: string) => MemoryNote | undefined;
  topK?: number;
  previewLength?: number;
}): RetrievalController {
  const topK = deps.topK ?? 5;
  const previewLength = deps.previewLength ?? 200;
  let searched = false;

  function previewFor(filePath: string): string {
    const note = deps.readNote(filePath);
    if (note === undefined) return "";
    const normalized = note.content.replace(/\n/g, " ");
    if (normalized.length > previewLength) {
      return `${normalized.slice(0, previewLength)}…`;
    }
    return normalized;
  }

  return {
    get searched(): boolean {
      return searched;
    },

    reset(): void {
      searched = false;
    },

    async onUserTurn(query: string): Promise<string> {
      if (searched) return "";
      searched = true;

      let hits: { filePath: string; score: number }[];
      try {
        hits = await deps.search(query, topK);
      } catch {
        return "";
      }
      if (hits.length === 0) return "";

      const lines = hits.map((hit) => {
        const preview = previewFor(hit.filePath);
        return `- ${hit.filePath} (score ${hit.score.toFixed(3)}): ${preview}`;
      });

      return [RETRIEVAL_HEADER, ...lines].join("\n");
    },
  };
}

export function createMemoryToolCore(deps: MemoryToolCoreDeps): MemoryToolCore {
  const { embedder } = deps;
  const withLock = createMutex();

  return {
    saveMemory(content: string, tags: string[] = []): Promise<SaveMemoryToolResult> {
      return withLock(async () => {
        const note = writeMemory(content, tags);
        try {
          const vector = await embedder.embed(note.content);
          indexNote(note, vector);
          return { filePath: note.filePath, indexed: true, queued: false };
        } catch {
          enqueueForIndexing(note.filePath);
          return { filePath: note.filePath, indexed: false, queued: true };
        }
      });
    },

    searchMemory(query: string, topK: number = 5): Promise<SearchResult[]> {
      return search(query, topK, embedder, readIndex());
    },

    processPending(): Promise<{ indexed: number; failed: number }> {
      return withLock(async () => {
        const seen = new Set<string>();
        const paths: string[] = [];

        for (const filePath of dequeueAll()) {
          if (!seen.has(filePath)) {
            seen.add(filePath);
            paths.push(filePath);
          }
        }
        for (const note of filesNeedingIndex(listMemories(), readIndex())) {
          if (!seen.has(note.filePath)) {
            seen.add(note.filePath);
            paths.push(note.filePath);
          }
        }

        let indexed = 0;
        let failed = 0;
        for (const filePath of paths) {
          const note = readNote(filePath);
          if (note === undefined) {
            failed += 1;
            continue;
          }
          try {
            const vector = await embedder.embed(note.content);
            indexNote(note, vector);
            indexed += 1;
          } catch {
            enqueueForIndexing(filePath);
            failed += 1;
          }
        }

        return { indexed, failed };
      });
    },

    preflight(): Promise<PreflightResult> {
      return runPreflight(embedder);
    },
  };
}

/**
 * Read the model-facing memory instructions, resolved relative to this file
 * with a cwd-relative fallback. Never throws.
 */
export function readInstructions(): string {
  const fallback =
    "Use save_memory to store durable facts and search_memory to retrieve them from long-term memory.";

  const candidates: string[] = [];
  try {
    candidates.push(
      fileURLToPath(new URL("../prompts/memory-instructions.md", import.meta.url)),
    );
  } catch {
    // import.meta.url unavailable in some loaders; fall through to cwd path.
  }
  candidates.push(path.join(process.cwd(), "prompts", "memory-instructions.md"));

  for (const filePath of candidates) {
    try {
      const text = readFileSync(filePath, "utf8").trim();
      if (text.length > 0) return text;
    } catch {
      // try the next candidate
    }
  }

  return fallback;
}

export default function semanticMemory(pi: ExtensionAPI): void {
  const embedder = createOllamaEmbedder();
  const core = createMemoryToolCore({ embedder });
  const controller = createRetrievalController({
    search: (query, topK) => core.searchMemory(query, topK),
    readNote,
  });
  const instructions = readInstructions();

  const saveMemory = defineTool({
    name: "save_memory",
    label: "Save Memory",
    description:
      "Save a durable, self-contained note to long-term memory. One topic per note; use tags to make it searchable later.",
    parameters: Type.Object({
      content: Type.String({ description: "The note body: one topic, self-contained." }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const res = await core.saveMemory(params.content, params.tags);
      const text = res.queued
        ? `Saved memory note ${res.filePath} (queued for indexing — embeddings unavailable)`
        : `Saved memory note ${res.filePath}`;
      return { content: [{ type: "text", text }], details: res };
    },
  });

  const searchMemory = defineTool({
    name: "search_memory",
    label: "Search Memory",
    description:
      "Semantic search over long-term memory. Returns file paths and similarity scores, never note contents. Open a hit with the `read` tool to see the full note.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      topK: Type.Optional(
        Type.Number({ description: "Maximum number of results to return (default 5)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const results = await core.searchMemory(params.query, params.topK);
      const text =
        results.length === 0
          ? "No matching memories."
          : results.map((r) => `${r.filePath} (score ${r.score.toFixed(3)})`).join("\n");
      return { content: [{ type: "text", text }], details: { results } };
    },
  });

  pi.registerTool(saveMemory);
  pi.registerTool(searchMemory);

  pi.on("session_start", async (_event, ctx) => {
    controller.reset();
    const pr = await core.preflight();
    if (!pr.ok && pr.message) {
      ctx.ui.notify(pr.message, "warning");
    }
    await core.processPending().catch(() => {});
  });

  pi.on("before_agent_start", async (event) => {
    event.systemPromptOptions.sections.memory_instructions = instructions;
    if (event.messageType === "user") {
      const block = await controller.onUserTurn(event.prompt);
      if (block) {
        event.systemPromptOptions.sections.memory_retrieval = block;
      }
    }
  });
}
