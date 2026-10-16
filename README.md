# semantic_memory

![CI](https://github.com/humman0id/semantic-memory/actions/workflows/ci.yml/badge.svg)

A long-term memory extension for the [Pi coding agent](https://pi.dev). Notes are
stored as plain Markdown files with frontmatter, embedded locally with
[`embeddinggemma`](https://ollama.com/library/embeddinggemma) through Ollama, and
found by cosine similarity.

## How it works

```
save_memory ──▶ write <uuid>.md ──▶ embed (Ollama /api/embed) ──▶ .index.json {path, vector, hash}
search_memory ──▶ embed(query) ──▶ cosine similarity over .index.json ──▶ top-K paths + scores
```

- **Storage** — raw `.md` notes with `id`/`created`/`tags` frontmatter under `~/.pi/agent/memory/`.
- **Index** — `~/.pi/agent/memory/.index.json` holds `{filePath, vector, hash}`; only changed files are re-embedded.
- **Search** — returns file paths + scores, never note contents; the model opens hits with Pi's built-in `read` tool.
- **Retrieval** — on the first user message of a session, the extension searches once and injects the top paths with previews into context.
- **Preflight** — if Ollama is down, Pi shows a clear message instead of crashing; `save_memory` still writes the note and queues it for indexing.

## Install

```bash
# 1. pull the embedding model
ollama pull embeddinggemma

# 2. install this package (local path)
pi install "$PWD"
```

## Configure

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SEMANTIC_MEMORY_EMBED_URL` | `http://localhost:11434` | Base URL of the Ollama embed endpoint |
| `SEMANTIC_MEMORY_EMBED_MODEL` | `embeddinggemma` | Embedding model name |
| `SEMANTIC_MEMORY_DIR` | `~/.pi/agent/memory` | Override the memory storage directory |
| `SEMANTIC_MEMORY_DUP_SCORE` | `0.95` | note→note similarity at/above which a save is a duplicate |
| `SEMANTIC_MEMORY_SIMILAR_SCORE` | `0.62` | note→note similarity at/above which a save returns candidates |
| `SEMANTIC_MEMORY_MIN_SCORE` | `0.44` | query→note floor for automatic injection |

Memory is stored under `~/.pi/agent/memory/`. Notes are `.md` files with
`id`, `created`, and `tags` frontmatter; the index lives at
`~/.pi/agent/memory/.index.json`.

## Storage

This extension writes only three things under `~/.pi/agent/memory/`:

- `<uuid>.md` — one note per file, frontmatter `id`/`created`/`tags`
- `.index.json` — `{filePath, vector, hash}` per indexed note
- `.queue.json` — note paths awaiting indexing

If another memory extension shares that directory (for example `pi-memory`,
which writes `MEMORY.md` and `daily/`/`recovery/`), keep them isolated by
redirecting this one:

```bash
export SEMANTIC_MEMORY_DIR="$HOME/.pi/agent/semantic-memory"
```

## Usage

In a Pi session the model can call three tools:

```
save_memory(content="User prefers tabs over spaces.", tags=["preference", "style"])
update_memory(file_path="/abs/path/note.md", content="User prefers tabs, not spaces.")
search_memory(query="code formatting preference", topK=5)
```

- `save_memory` dedupes: near-identical content updates the existing note's
  timestamp; similar content returns candidates instead of writing (use
  `allowNew: true` to force a new note).
- `update_memory` replaces a note's body, keeps `id`/`created`, sets `updated`,
  archives the previous version to `.archive/`, and re-indexes.
- On the first user message of a session, the extension searches once and
  injects the top matching note paths (above `SEMANTIC_MEMORY_MIN_SCORE`) into
  context. The model opens full notes with the built-in `read` tool.

## Development

```bash
npm install
npm test              # vitest, mocked embedder
npm run lint
npx tsc --noEmit
npm run check-goal    # full integration gate (needs `pi` + Ollama)
```
