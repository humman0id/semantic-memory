# Progress

Log of iterations toward the GOAL. Orchestrator-only file.

## Phase 0 — Orient (done)

- Read Pi docs: `extensions.md`, `packages.md`, `sdk.md`, `cli-integration.md`,
  `prompt-templates.md`; examples `todo.ts`, `hello.ts`, `system-prompt-header.ts`,
  `prompt-customizer.ts`, `send-user-message.ts`, sdk `03/06`; and
  `dist/core/extensions/types.d.ts`, `dist/core/system-prompt.d.ts`.
- Confirmed embedding tag `embeddinggemma` in Ollama's library
  (`ollama pull embeddinggemma`, `POST /api/embed`).
- Wrote `docs/pi-notes.md`.

## Phase 1 — Scaffold (done)

- Created `package.json` (Pi manifest `pi.extensions: ["./src/index.ts"]`,
  host packages in `peerDependencies`), `tsconfig.json`, eslint + vitest config,
  `.gitignore`, `prompts/memory-instructions.md`, `README.md`, `AGENTS.md`,
  `GOAL.md`.

## Phase 2 — Contracts (done)

- Wrote `docs/contracts.md`: module signatures (`embed.ts`, `preflight.ts`,
  `store.ts`, `search.ts`, `index.ts`) and data formats (note frontmatter,
  `.index.json`, `.queue.json`).
- Added `readNote` and `createMemoryToolCore` / `createRetrievalController`
  testable seams so `check-goal.ts` can verify criteria 3/5/6 without a model.
- Wrote `scripts/check-goal.ts` (checks all 7 criteria; baseline: 1/7 pass,
  criterion 7 README only — rest fail as expected on stubs).

## Phase 3 — Build via subagents

### store-agent + embed-agent (done, parallel)

- store-agent implemented `src/store.ts` + `src/search.ts` and
  `test/store.test.ts` + `test/search.test.ts` (16 + 9 tests).
- embed-agent implemented `src/embed.ts` + `src/preflight.ts` and
  `test/embed.test.ts` + `test/preflight.test.ts` (10 tests).
- Full validation now: `tsc --noEmit` pass, `eslint .` pass except 3 stub
  errors in `src/index.ts` (expected, hooks-agent pending), `vitest run` 35/35.
- Convention noted: value imports use `.js` (NodeNext); type-only imports may
  use `.ts`. jiti (Pi's loader) resolves both.
- No contract changes required.

### hooks-agent

- (done) implemented `src/index.ts` (retrieval controller, memory-tool core,
  instruction loading, Pi tool/event wiring) and `test/index.test.ts` (6 tests).
  `prompts/memory-instructions.md` already accurate, left unchanged.

### Integration (orchestrator)

- `tsc --noEmit`, `eslint .`, and `vitest run` (41/41) all green.
- `scripts/check-goal.ts` exits 0: 7/7 criteria. Pulled `embeddinggemma`
  (621 MB) so criterion 4 runs against real Ollama instead of skipping.

## Loop iterations

- Iteration 1 (single pass): after subagents, check-goal exited 0 on first
  run. No failing criteria to fix.

## Done

- `npx tsx scripts/check-goal.ts` exits 0 (7/7).

---

# Feature 2 — Memory hygiene

Started. New criteria appended to GOAL.md as 8–13 (renumbered from the task's
11–16 per orchestrator/user clarification; existing 1–7 untouched). Goals:

- Dedupe/update-instead-of-add on `save_memory` (`allowNew?`, DUP/SIMILAR scores).
- New `update_memory` tool (archive-to-`.archive`, `updated` frontmatter).
- Injection threshold `SEMANTIC_MEMORY_MIN_SCORE`; `search_memory` minScore param.
- Calibration script → `docs/decisions.md`; read-only `find-duplicates.ts`.
- `.possible-dupes.json` for queue-time near-duplicates.

## Iterations

- **Iteration 1** — Implemented memory hygiene directly (store-agent subagent
  aborted on launch; user said continue). Added: `updated` frontmatter, archive
  (`store.archiveNote`/`updateMemory`/`touchUpdated`/`resolveMemoryPath`),
  `.possible-dupes.json`, `searchVector` + `minScore`; rewrote `index.ts`
  (dedupe save, `update_memory` tool, minScore injection, queue-time possible
  dupes, session_start notify) and updated `prompts/memory-instructions.md`.
  Updated `check-goal.ts` to 13 criteria. `tsc`/`eslint`/`vitest` (63) green;
  check-goal 12/13 — criterion 13 false negative in the check itself (a stray
  second queued note), fixed in the same iteration.
- **Iteration 2** — final `check-goal.ts` run: **13/13, exit 0**. Updated README
  (config table + usage).

## Calibration result

`embeddinggemma` (via Ollama): DUP=0.95, SIMILAR=0.62, MIN=0.44 — recorded in
`docs/decisions.md`. Note/note duplicate and same-topic classes overlap, so
DUP is set above the same-topic max (near-verbatim only); the ambiguous band is
handled by the similar/candidates path.

## find-duplicates (read-only) result

Ran against `~/.pi/agent/memory`: **0 note(s)** — the directory currently
contains only `.index.json` and `.queue.json` (the two earlier smoke-test notes
are no longer present). Script did not modify anything.

## Done

- `npx tsx scripts/check-goal.ts` exits 0 (13/13).
