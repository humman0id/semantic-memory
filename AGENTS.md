# AGENTS.md — rules for anyone working in this repo

This repo builds `semantic_memory`, a long-term memory extension for the Pi
coding agent (TypeScript/Node).

## Ground rules

- **Never invent Pi APIs.** Verify every hook, event, tool-registration call, and
  package-manifest key against Pi's docs and examples. The Pi package lives under
  `@earendil-works/` (it may also appear under `@mariozechner/`). Docs and
  examples are in the installed Pi release; captured notes are in
  `docs/pi-notes.md`.
- **If something is ambiguous or the docs contradict an instruction, stop and
  ask.** Do not guess.
- **Only the orchestrator edits** `GOAL.md`, `docs/contracts.md`, and
  `docs/progress.md`. Subagents read these, never edit them.
- **Subagents edit only their assigned files** (see the build plan). Code against
  `docs/contracts.md`. If a contract is wrong or missing, stop and report back
  instead of editing the contract or other files.
- **Subagents never message each other**; everything goes through the orchestrator.

## Design (MVP)

- Memory = raw `.md` files with frontmatter (`id`, `created`, `tags`) in
  `~/.pi/agent/memory/`.
- Each file is embedded with `embeddinggemma` through a local OpenAI-compatible
  endpoint (Ollama by default). Env vars: `SEMANTIC_MEMORY_EMBED_URL`
  (default `http://localhost:11434`), `SEMANTIC_MEMORY_EMBED_MODEL`
  (default `embeddinggemma`). The embedder is a pluggable interface.
- Index: `memory/.index.json` holding `{filePath, vector, hash}`. Only changed
  files are re-embedded.
- Search: cosine similarity returning file paths + scores, never contents. The
  model opens hits with Pi's built-in `read` tool — there is no `read_memory` tool.
- Tools: `save_memory(content, tags)` and `search_memory(query, topK)`.
- Retrieval: on the first user message of a session, search once and inject the
  top paths with short previews into context. No per-turn search.
- System prompt: the extension injects `prompts/memory-instructions.md` itself
  (do not rely on the user's `APPEND_SYSTEM.md`).
- Preflight: if the endpoint or model is unavailable, show a clear message
  ("Run `ollama pull embeddinggemma`") and never crash the session.
  `save_memory` still writes the file and queues it for indexing once embeddings
  are back.

## Out of scope (MVP)

Temporary memory, tool-call logging, `/memory-doctor`, publishing workflows,
evals. Leave clean extension points; do not build these.

## Definition of done

`npx tsx scripts/check-goal.ts` exits 0. See `GOAL.md` for the exact criteria.
