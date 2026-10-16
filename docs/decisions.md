# Decisions — threshold calibration

## Model

- Embedding model: `embeddinggemma` (Ollama `POST /api/embed`, localhost:11434).
- Calibrated: 2026-10-16 via `scripts/calibrate-thresholds.ts`.
- These thresholds are **specific to this embedding model**. Re-run the script
  if the model changes.

## Measured distributions (cosine similarity)

| Class | n | min | max | mean | median |
|---|---|---|---|---|---|
| note/note — true duplicates (reworded) | 4 | 0.780 | 0.879 | 0.837 | 0.844 |
| note/note — same topic, different/contradicting fact | 4 | 0.720 | **0.944** | 0.830 | 0.829 |
| note/note — unrelated | 4 | 0.144 | 0.515 | 0.276 | 0.223 |
| query/note — relevant first message | 4 | 0.522 | 0.813 | 0.654 | 0.640 |
| query/note — irrelevant first message | 4 | 0.175 | 0.356 | 0.257 | 0.249 |

## Key finding

The **true-duplicate and same-topic classes overlap** (`dup.min = 0.780` is
below `same-topic.max = 0.944`). The clearest example is the contradiction
"prefers npm" vs "prefers pnpm", which scores **0.944** — higher than every
reworded duplicate. So cosine similarity alone cannot reliably separate a
reworded duplicate from a same-topic-but-different fact with this model.

## Chosen defaults

| Env var | Value | Reasoning |
|---|---|---|
| `SEMANTIC_MEMORY_DUP_SCORE` | `0.95` | Set **above** the measured same-topic max (0.944) so the auto-dedupe path only fires on near-verbatim text. The ambiguous band (reworded dups + same-topic/contradictions) is handled by the *similar* path, which returns candidates and lets the model call `update_memory` or `save_memory(..., allowNew: true)`. This trades auto-dedupe convenience for never silently dropping a contradictory fact. |
| `SEMANTIC_MEMORY_SIMILAR_SCORE` | `0.62` | Midpoint of the clean gap between unrelated max (0.515) and same-topic min (0.720). |
| `SEMANTIC_MEMORY_MIN_SCORE` | `0.44` | Midpoint of the clean gap between query-irrelevant max (0.356) and query-relevant min (0.522). Query→note scores are distributed lower than note→note, so this is calibrated separately. |

## Implications

- `save_memory` will rarely take the auto-dedupe (`duplicate`) path for reworded
  text; most near-duplicates land in `similar` and surface candidates to the
  model. This is intentional and safer than silent fact loss.
- `MIN_SCORE` applies only to the automatic first-message injection, not to the
  explicit `search_memory` tool (which returns all scored results).
