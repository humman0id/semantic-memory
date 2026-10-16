/**
 * Extension entry point: tool registration, session-start preflight + pending
 * indexing, dedupe/update-instead-of-add on save, and first-message retrieval
 * injection.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createOllamaEmbedder, type Embedder } from "./embed.js";
import { preflight as runPreflight, type PreflightResult } from "./preflight.js";
import { search, searchVector, type SearchResult } from "./search.js";
import {
  archiveNote,
  clearPossibleDupes,
  dequeueAll,
  enqueueForIndexing,
  filesNeedingIndex,
  hashText,
  indexNote,
  listMemories,
  readIndex,
  readNote,
  readPossibleDupes,
  recordPossibleDupe,
  resolveMemoryPath,
  touchUpdated,
  updateMemory as rewriteMemory,
  writeMemory,
  type MemoryIndex,
  type MemoryNote,
  type PossibleDupes,
} from "./store.js";

export type SaveMemoryStatus = "saved" | "queued" | "duplicate" | "similar";

export interface SaveCandidate {
  filePath: string;
  score: number;
  preview: string;
}

export interface SaveMemoryToolResult {
  status: SaveMemoryStatus;
  filePath?: string;
  indexed: boolean;
  queued: boolean;
  score?: number;
  preview?: string;
  candidates?: SaveCandidate[];
}

export interface UpdateMemoryToolResult {
  ok: boolean;
  filePath?: string;
  archivePath?: string;
  error?: string;
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
  dupScore?: number;
  similarScore?: number;
  minScore?: number;
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

const RETRIEVAL_HEADER =
  "Relevant long-term memory (open with the `read` tool when needed):";

export const DUPLICATE_INSTRUCTION =
  "If this note does not already say the same thing as your new content (for example the fact has changed), call update_memory on this path instead.";

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

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
  search: (query: string, topK: number, minScore?: number) => Promise<{ filePath: string; score: number }[]>;
  readNote: (filePath: string) => MemoryNote | undefined;
  topK?: number;
  previewLength?: number;
  minScore?: number;
}): RetrievalController {
  const topK = deps.topK ?? 5;
  const previewLength = deps.previewLength ?? 200;
  const minScore = deps.minScore ?? envFloat("SEMANTIC_MEMORY_MIN_SCORE", 0.44);
  let searched = false;

  function previewFor(filePath: string): string {
    const note = deps.readNote(filePath);
    if (note === undefined) return "";
    const normalized = note.content.replace(/\n/g, " ");
    return normalized.length > previewLength ? `${normalized.slice(0, previewLength)}…` : normalized;
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
        hits = await deps.search(query, topK, minScore);
      } catch {
        return "";
      }
      if (hits.length === 0) return "";

      const lines = hits.map(
        (hit) => `- ${hit.filePath} (score ${hit.score.toFixed(3)}): ${previewFor(hit.filePath)}`,
      );
      return [RETRIEVAL_HEADER, ...lines].join("\n");
    },
  };
}

export function createMemoryToolCore(deps: MemoryToolCoreDeps): MemoryToolCore {
  const { embedder } = deps;
  const previewLength = deps.previewLength ?? 200;
  const dupScore = deps.dupScore ?? envFloat("SEMANTIC_MEMORY_DUP_SCORE", 0.97);
  const similarScore = deps.similarScore ?? envFloat("SEMANTIC_MEMORY_SIMILAR_SCORE", 0.59);
  const withLock = createMutex();

  function previewOf(filePath: string): string {
    const note = readNote(filePath);
    if (note === undefined) return "";
    const normalized = note.content.replace(/\n/g, " ");
    return normalized.length > previewLength ? `${normalized.slice(0, previewLength)}…` : normalized;
  }

  function toCandidates(vector: number[], count: number, index: MemoryIndex): SaveCandidate[] {
    return searchVector(vector, count, index).map((hit) => ({
      filePath: hit.filePath,
      score: hit.score,
      preview: previewOf(hit.filePath),
    }));
  }

  return {
    saveMemory(content: string, tags: string[] = [], allowNew = false): Promise<SaveMemoryToolResult> {
      return withLock(async () => {
        let vector: number[];
        try {
          vector = await embedder.embed(content);
        } catch {
          const note = writeMemory(content, tags);
          enqueueForIndexing(note.filePath);
          return { status: "queued", filePath: note.filePath, indexed: false, queued: true };
        }

        const index = readIndex();
        const top = searchVector(vector, 1, index)[0];

        if (top !== undefined && top.score >= dupScore) {
          const existing = readNote(top.filePath);
          if (existing !== undefined && hashText(existing.content) === hashText(content)) {
            touchUpdated(top.filePath);
          }
          return {
            status: "duplicate",
            filePath: top.filePath,
            score: top.score,
            preview: previewOf(top.filePath),
            indexed: false,
            queued: false,
          };
        }

        if (top !== undefined && top.score >= similarScore && !allowNew) {
          return {
            status: "similar",
            score: top.score,
            candidates: toCandidates(vector, 3, index),
            indexed: false,
            queued: false,
          };
        }

        const note = writeMemory(content, tags);
        indexNote(note, vector);
        return { status: "saved", filePath: note.filePath, indexed: true, queued: false };
      });
    },

    updateMemory(filePath: string, content: string, tags?: string[]): Promise<UpdateMemoryToolResult> {
      return withLock(async () => {
        const resolved = resolveMemoryPath(filePath);
        if (resolved === undefined) {
          return { ok: false, error: `invalid file_path: ${filePath}` };
        }

        const archivePath = archiveNote(resolved);
        const note = rewriteMemory(resolved, content, tags);
        if (note === undefined) {
          return { ok: false, error: `note not found: ${filePath}` };
        }

        try {
          const vector = await embedder.embed(note.content);
          indexNote(note, vector);
        } catch {
          enqueueForIndexing(note.filePath);
        }

        return { ok: true, filePath: note.filePath, archivePath };
      });
    },

    searchMemory(query: string, topK = 5, minScore?: number): Promise<SearchResult[]> {
      return search(query, topK, embedder, readIndex(), { minScore });
    },

    processPending(): Promise<{ indexed: number; failed: number; possibleDupes: number }> {
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
        let possibleDupes = 0;

        for (const filePath of paths) {
          const note = readNote(filePath);
          if (note === undefined) {
            failed += 1;
            continue;
          }

          let vector: number[];
          try {
            vector = await embedder.embed(note.content);
          } catch {
            enqueueForIndexing(filePath);
            failed += 1;
            continue;
          }

          const index = readIndex();
          const top = searchVector(vector, 1, index)[0];
          if (top !== undefined && top.score >= similarScore) {
            recordPossibleDupe({
              filePath,
              at: new Date().toISOString(),
              candidates: searchVector(vector, 3, index).map((hit) => ({
                filePath: hit.filePath,
                score: hit.score,
              })),
            });
            possibleDupes += 1;
            // do NOT index/delete/merge — leave the file on disk.
            continue;
          }

          indexNote(note, vector);
          indexed += 1;
        }

        return { indexed, failed, possibleDupes };
      });
    },

    preflight(): Promise<PreflightResult> {
      return runPreflight(embedder);
    },

    getPossibleDupes(): PossibleDupes {
      return readPossibleDupes();
    },

    clearPossibleDupes(): void {
      clearPossibleDupes();
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
    candidates.push(fileURLToPath(new URL("../prompts/memory-instructions.md", import.meta.url)));
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

export function renderSaveResult(res: SaveMemoryToolResult): string {
  switch (res.status) {
    case "saved":
      return `Saved memory note ${res.filePath}`;
    case "queued":
      return `Saved memory note ${res.filePath} (queued for indexing — embeddings unavailable)`;
    case "duplicate":
      return `Duplicate of existing note ${res.filePath} (score ${res.score?.toFixed(3)}): ${res.preview ?? ""}\n${DUPLICATE_INSTRUCTION}`;
    case "similar": {
      const lines = [
        `Not saved: ${res.candidates?.length ?? 0} similar note(s) exist (top score ${res.score?.toFixed(3)}). Update one of these with update_memory, or call save_memory again with allowNew:true if this is a genuinely distinct fact.`,
      ];
      for (const candidate of res.candidates ?? []) {
        lines.push(`- ${candidate.filePath} (score ${candidate.score.toFixed(3)}): ${candidate.preview}`);
      }
      return lines.join("\n");
    }
  }
}

export default function semanticMemory(pi: ExtensionAPI): void {
  const embedder = createOllamaEmbedder();
  const core = createMemoryToolCore({ embedder });
  const controller = createRetrievalController({
    search: (query, topK, minScore) => core.searchMemory(query, topK, minScore),
    readNote,
  });
  const instructions = readInstructions();

  const saveMemory = defineTool({
    name: "save_memory",
    label: "Save Memory",
    description:
      "Save a durable, self-contained note to long-term memory. One topic per note. If a similar note already exists this returns candidates instead of writing; use allowNew only for a genuinely distinct fact.",
    parameters: Type.Object({
      content: Type.String({ description: "The note body: one topic, self-contained." }),
      tags: Type.Optional(Type.Array(Type.String())),
      allowNew: Type.Optional(
        Type.Boolean({ description: "Force writing a new note even when a similar one exists." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const res = await core.saveMemory(params.content, params.tags, params.allowNew);
      return { content: [{ type: "text", text: renderSaveResult(res) }], details: res };
    },
  });

  const searchMemory = defineTool({
    name: "search_memory",
    label: "Search Memory",
    description:
      "Semantic search over long-term memory. Returns file paths and similarity scores, never note contents. Open a hit with the `read` tool to see the full note.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      topK: Type.Optional(Type.Number({ description: "Maximum number of results (default 5)." })),
      minScore: Type.Optional(Type.Number({ description: "Minimum similarity score to return." })),
    }),
    async execute(_toolCallId, params) {
      const results = await core.searchMemory(params.query, params.topK, params.minScore);
      const text =
        results.length === 0
          ? "No matching memories."
          : results.map((r) => `${r.filePath} (score ${r.score.toFixed(3)})`).join("\n");
      return { content: [{ type: "text", text }], details: { results } };
    },
  });

  const updateMemoryTool = defineTool({
    name: "update_memory",
    label: "Update Memory",
    description:
      "Update an existing memory note in place. Replaces the body, preserves id and created, sets `updated`, and archives the previous version. Pass the note's file path.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to the existing .md note in the memory directory." }),
      content: Type.String({ description: "New note body." }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      const res = await core.updateMemory(params.file_path, params.content, params.tags);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${res.error}` }], details: res };
      }
      const text = `Updated memory note ${res.filePath} (previous version archived to ${res.archivePath})`;
      return { content: [{ type: "text", text }], details: res };
    },
  });

  pi.registerTool(saveMemory);
  pi.registerTool(searchMemory);
  pi.registerTool(updateMemoryTool);

  pi.on("session_start", async (_event, ctx) => {
    controller.reset();
    const pr = await core.preflight();
    if (!pr.ok && pr.message) {
      ctx.ui.notify(pr.message, "warning");
    }
    await core.processPending().catch(() => {});
    const dupes = core.getPossibleDupes();
    if (dupes.entries.length > 0) {
      ctx.ui.notify(
        `Found ${dupes.entries.length} possible duplicate memory note(s); see .possible-dupes.json`,
        "warning",
      );
      core.clearPossibleDupes();
    }
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
