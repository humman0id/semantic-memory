# Decisions — threshold calibration

## Model

- Embedding model: `embeddinggemma` (Ollama `POST /api/embed`, localhost:11434).
- Calibrated: 2026-10-16 via `scripts/calibrate-thresholds.ts` (expanded labeled set).
- These thresholds are **specific to this embedding model**. Re-run the script
  if the model changes.

## Measured distributions (cosine similarity)

| Class | n | min | max | mean | median |
|---|---|---|---|---|---|
| note/note — true duplicates (reworded) | 9 | 0.730 | 0.961 | 0.837 | 0.826 |
| note/note — same topic, different/contradicting fact | 9 | 0.664 | **0.944** | 0.827 | 0.847 |
| note/note — unrelated | 4 | 0.144 | 0.515 | 0.276 | 0.223 |
| query/note — relevant first message | 4 | 0.522 | 0.813 | 0.654 | 0.640 |
| query/note — irrelevant first message | 4 | 0.175 | 0.356 | 0.257 | 0.249 |

The contradiction set covers tool (ESLint/Biome), language (TypeScript/Go),
framework (React/Vue), preference (dark/light mode), and numeric-value
(100 vs 500 req/min) changes, plus npm/pnpm, serverless, indentation, and
Vitest/Jest.

## Key finding

The **true-duplicate and same-topic classes still overlap** (`dup.min = 0.730`
is below `same-topic.max = 0.944`). The highest contradiction is "prefers npm"
vs "prefers pnpm" at **0.944** — higher than most reworded duplicates. Cosine
similarity alone cannot reliably separate a reworded duplicate from a
same-topic-but-different fact with this model.

## Chosen defaults

| Env var | Value | Reasoning |
|---|---|---|
| `SEMANTIC_MEMORY_DUP_SCORE` | `0.97` | **Max change/contradiction score (0.944) + recorded margin (0.03).** Only near-verbatim content auto-dedupes; a contradiction scoring near the max is routed through the *similar* path instead of being silently dropped. |
| `SEMANTIC_MEMORY_SIMILAR_SCORE` | `0.59` | Midpoint of the clean gap between unrelated max (0.515) and same-topic min (0.664). |
| `SEMANTIC_MEMORY_MIN_SCORE` | `0.44` | Midpoint of the clean gap between query-irrelevant max (0.356) and query-relevant min (0.522). Query→note scores are distributed lower than note→note. |

## Implications

- `save_memory` auto-dedupes (`duplicate`) only for near-verbatim text
  (score ≥ 0.97); reworded duplicates and same-topic changes land in `similar`
  and surface candidates to the model, which decides between `update_memory`
  and `save_memory(..., allowNew: true)`.
- On a `duplicate`, the note's `updated` timestamp is refreshed **only** when
  the new content is byte-identical to the existing note's body (a true
  re-save); a merely-similar match does not make the note look recently
  verified.
- `MIN_SCORE` applies only to the automatic first-message injection, not to the
  explicit `search_memory` tool (which returns all scored results).
