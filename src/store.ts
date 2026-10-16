/**
 * Filesystem store for memory notes, the index, and the pending queue.
 * Implemented in Phase 3 by store-agent.
 */

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
  throw new Error("not implemented");
}

export function indexPath(): string {
  throw new Error("not implemented");
}

export function queuePath(): string {
  throw new Error("not implemented");
}

export function hashText(_text: string): string {
  throw new Error("not implemented");
}

export function writeMemory(_content: string, _tags?: string[]): MemoryNote {
  throw new Error("not implemented");
}

export function listMemories(): MemoryNote[] {
  throw new Error("not implemented");
}

export function readIndex(): MemoryIndex {
  throw new Error("not implemented");
}

export function writeIndex(_index: MemoryIndex): void {
  throw new Error("not implemented");
}

export function upsertIndexEntry(_index: MemoryIndex, _entry: IndexEntry): MemoryIndex {
  throw new Error("not implemented");
}

export function indexNote(_note: MemoryNote, _vector: number[]): void {
  throw new Error("not implemented");
}

export function readQueue(): IndexQueue {
  throw new Error("not implemented");
}

export function writeQueue(_queue: IndexQueue): void {
  throw new Error("not implemented");
}

export function enqueueForIndexing(_filePath: string): void {
  throw new Error("not implemented");
}

export function dequeueAll(): string[] {
  throw new Error("not implemented");
}

export function filesNeedingIndex(_memories: MemoryNote[], _index: MemoryIndex): MemoryNote[] {
  throw new Error("not implemented");
}
