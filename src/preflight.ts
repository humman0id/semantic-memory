/**
 * Preflight check: ensure the embedding endpoint/model is usable without
 * crashing the session. Implemented in Phase 3 by embed-agent.
 */

import type { Embedder } from "./embed.ts";

export interface PreflightResult {
  ok: boolean;
  message?: string;
}

export function buildPreflightMessage(_reason: string): string {
  throw new Error("not implemented");
}

export function preflight(_embedder: Embedder): Promise<PreflightResult> {
  throw new Error("not implemented");
}
