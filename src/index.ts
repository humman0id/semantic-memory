/**
 * Extension entry point: tool registration, session-start preflight, and
 * first-message retrieval injection. Implemented in Phase 3 by hooks-agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Embedder } from "./embed.ts";
import type { PreflightResult } from "./preflight.ts";
import type { SearchResult } from "./search.ts";
import type { MemoryNote } from "./store.ts";

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

export function createRetrievalController(_deps: {
  search: (query: string, topK: number) => Promise<{ filePath: string; score: number }[]>;
  readNote: (filePath: string) => MemoryNote | undefined;
  topK?: number;
  previewLength?: number;
}): RetrievalController {
  throw new Error("not implemented");
}

export function createMemoryToolCore(_deps: MemoryToolCoreDeps): MemoryToolCore {
  throw new Error("not implemented");
}

export default function semanticMemory(_pi: ExtensionAPI): void {
  throw new Error("not implemented");
}
