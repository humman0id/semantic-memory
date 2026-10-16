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

## Phase 2 — Contracts

- (pending)

## Loop iterations

- (none yet)
