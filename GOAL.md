# GOAL — semantic_memory MVP

Build a long-term memory extension for the Pi coding agent: Markdown notes,
local embeddings (`embeddinggemma` via Ollama), and cosine-similarity search.

## Checkable criteria

1. Lint and unit tests pass.
2. `pi install "$PWD"` loads the extension without errors.
3. `save_memory` writes a `.md` file with valid frontmatter and indexes it.
4. `search_memory` returns the right file path for a paraphrased query
   (integration test against real Ollama, skipped if unavailable).
5. In a fresh Pi session, the first message triggers exactly one search and the
   top paths appear in context. If Pi cannot be driven non-interactively, log
   that in `docs/pi-notes.md` and propose a manual check instead of faking it.
6. With Ollama stopped, the session starts, shows the clear message, and
   `save_memory` still writes the file and queues it for indexing.
7. README has install, config, and a 5-line usage example.
8. Saving near-identical content twice yields one file; the second call
   returns the duplicate result with the existing path. Covered by
   mocked-embedder unit tests and a real-Ollama integration test (skipped if
   Ollama is unavailable).
9. A similar-but-not-duplicate save writes nothing and returns candidates;
   the same save with `allowNew: true` writes the file.
10. `update_memory` replaces content, preserves `id`/`created`, sets `updated`,
    archives the previous version, updates the index, and searching the new
    wording finds the note. Paths outside the memory directory, non-`.md`
    files, and archive paths are rejected.
11. Injection threshold: with mocked scores, results below `SEMANTIC_MEMORY_MIN_SCORE`
    are not injected; if none pass, no section is injected; explicit
    `search_memory` still returns scored results.
12. `scripts/calibrate-thresholds.ts` has been run against real
    `embeddinggemma`; `docs/decisions.md` records the distributions; code
    defaults match the recorded numbers.
13. With Ollama down, `save_memory` still writes and queues without crashing;
    processing the queue later records possible duplicates in
    `.possible-dupes.json` instead of deleting anything.

## Out of scope (MVP)

Temporary memory, tool-call logging, `/memory-doctor`, publishing workflows,
evals. Do not build these; leave clean extension points.

## Done when

`npx tsx scripts/check-goal.ts` exits 0.
