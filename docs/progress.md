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
