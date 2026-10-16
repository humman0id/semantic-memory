/**
 * Preflight check: ensure the embedding endpoint/model is usable without
 * crashing the session.
 */

import type { Embedder } from "./embed.js";
import { probeEmbedder } from "./embed.js";

export interface PreflightResult {
  ok: boolean;
  message?: string; // clear user-facing message when !ok
}

/** Human message shown when the endpoint/model is unavailable. */
export function buildPreflightMessage(reason: string): string {
  return `Memory embeddings unavailable: ${reason}. Run \`ollama pull embeddinggemma\`.`;
}

export async function preflight(embedder: Embedder): Promise<PreflightResult> {
  try {
    const s = await probeEmbedder(embedder);
    return {
      ok: s.available,
      message: s.available ? undefined : buildPreflightMessage(s.error ?? "unknown error"),
    };
  } catch (error) {
    return {
      ok: false,
      message: buildPreflightMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}
