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

## Out of scope (MVP)

Temporary memory, tool-call logging, `/memory-doctor`, publishing workflows,
evals. Do not build these; leave clean extension points.

## Done when

`npx tsx scripts/check-goal.ts` exits 0.
