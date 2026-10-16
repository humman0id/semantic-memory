# Tests

Vitest unit tests live here. Conventions:

- The embedder is **always mocked** — no network in unit tests. Each test file
  defines its own fake `Embedder` (`{ embed: async (t) => [...] }`).
- The memory directory is redirected to a temp dir by setting
  `process.env.SEMANTIC_MEMORY_DIR` before calling store functions. Clean up
  with `fs.rmSync(dir, { recursive: true, force: true })`.
- Real-Ollama integration is exercised only by `scripts/check-goal.ts`
  (criterion 4), which skips when the endpoint is unavailable.

Run with `npm test` (`vitest run`).
