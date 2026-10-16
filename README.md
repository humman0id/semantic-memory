# semantic_memory

A long-term memory extension for the [Pi coding agent](https://pi.dev). Notes are
stored as plain Markdown files with frontmatter, embedded locally with
[`embeddinggemma`](https://ollama.com/library/embeddinggemma) through Ollama, and
found by cosine similarity.

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
| `SEMANTIC_MEMORY_EMBED_URL` | `http://localhost:11434` | Base URL of the OpenAI-compatible embedding endpoint |
| `SEMANTIC_MEMORY_EMBED_MODEL` | `embeddinggemma` | Embedding model name |

Memory is stored under `~/.pi/agent/memory/`. Notes are `.md` files with
`id`, `created`, and `tags` frontmatter; the index lives at
`~/.pi/agent/memory/.index.json`.

## Usage

In a Pi session the model can call two tools:

```
save_memory(content="User prefers tabs over spaces.", tags=["preference", "style"])
search_memory(query="code formatting preference", topK=5)
```

On the first user message of a session, the extension searches once and injects
the top matching note paths (with short previews) into context. The model opens
full notes with the built-in `read` tool.
