import { describe, expect, it } from "vitest";

import {
  buildPreflightMessage,
  preflight,
  type PreflightResult,
} from "../src/preflight.js";
import type { Embedder } from "../src/embed.js";

describe("buildPreflightMessage", () => {
  it("contains the ollama pull hint", () => {
    const message = buildPreflightMessage("connection refused");
    expect(message).toContain("ollama pull embeddinggemma");
    expect(message).toContain("connection refused");
  });
});

describe("preflight", () => {
  it("returns ok true for a succeeding embedder", async () => {
    const ok: Embedder = { embed: async () => [0.1, 0.2] };
    await expect(preflight(ok)).resolves.toEqual({ ok: true });
  });

  it("returns ok false with a pull hint for a throwing embedder", async () => {
    const broken: Embedder = {
      embed: async () => {
        throw new Error("down");
      },
    };
    const result: PreflightResult = await preflight(broken);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ollama pull embeddinggemma");
    expect(result.message).toContain("down");
  });
});
