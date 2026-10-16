# Pi Notes (verified against Pi 1.3.0 docs + examples)

These notes capture the verified integration points used by the `semantic_memory`
extension. They were checked against `@earendil-works/pi-coding-agent@1.3.0`
(`docs/extensions.md`, `docs/packages.md`, `docs/sdk.md`, `docs/cli-integration.md`,
`docs/prompt-templates.md`, `examples/extensions/`, `dist/core/extensions/types.d.ts`,
`dist/core/system-prompt.d.ts`). Do not invent APIs; every call below exists.

## 1. Tool registration

Tools are registered in the extension factory with `pi.registerTool(tool)`.

```ts
import { Type } from "@earendil-works/pi-ai";          // TypeBox re-export
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const saveMemory = defineTool({
  name: "save_memory",
  label: "Save Memory",
  description: "Save a durable note ...",
  parameters: Type.Object({
    content: Type.String({ description: "..." }),
    tags: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: "..." }],
      details: { /* structured state, optional */ },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(saveMemory);
}
```

Key facts:

- `ToolDefinition<TParams, TDetails, TState>` fields include `name`, `label`,
  `description`, `parameters` (TypeBox schema), `execute(...)`,
  optional `promptSnippet`, `promptGuidelines`, `outputSchema`, `exposure`,
  `annotations`, `defaultActive`, and renderers `renderCall` / `renderResult`.
- `execute(toolCallId, params, signal, onUpdate, ctx)` returns
  `{ content: [{ type: "text", text }], details? }`. Throw to produce a failed
  result. `details` carries structured state (not sent to the model).
- `defineTool()` preserves TypeBox parameter inference (use it when assigning a
  tool to a variable).
- `Type` (TypeBox) is available from both `@earendil-works/pi-ai` and the
  host-provided `typebox` package. `StringEnum([...])` is exported by
  `@earendil-works/pi-ai`.
- Default `exposure` is `"direct"` (declared to the model + callable). Custom
  tools are auto-activated on registration unless `defaultActive: false`.
- Mark tools read-only where true via `annotations: { readOnlyHint: true }`.

## 2. Session-start event

```ts
pi.on("session_start", async (_event, ctx) => { ... });
```

- `SessionStartEvent` = `{ type: "session_start", reason, previousSessionFile? }`
  where `reason` is `"startup" | "reload" | "new" | "resume" | "fork"`.
- Handler signature is `(event, ctx: ExtensionContext) => ... | Promise<...>`.
- `pi.on()` returns an unsubscribe function.
- Related lifecycle events: `session_shutdown` (`{ reason }`, use for idempotent
  cleanup), `session_tree`, `agent_start`, `agent_end`, `agent_settled`.
- `ExtensionContext` exposes `cwd`, `mode` (`"tui" | "rpc" | "json" | "print"`),
  `hasUI`, `ui.notify(msg, "info"|"warning"|"error")`, `isIdle()`, `signal`,
  `sessionManager`, `getSystemPrompt()`, `getContextUsage()`, etc.
- Do NOT start long-lived resources (watchers/timers/sockets) in the factory;
  start them from `session_start` and clean up in `session_shutdown`.

## 3. System-prompt modification

The supported mechanism is mutating prompt **sections** on `before_agent_start`.
This is how we inject `prompts/memory-instructions.md` and, on the first user
message of a session, the retrieval preview block.

```ts
pi.on("before_agent_start", (event) => {
  // event is BeforeAgentStartEvent
  if (event.messageType === "user") { /* skip custom-message runs */ }
  event.systemPromptOptions.sections.memory_instructions = "..."; // tagged section
});
```

Key facts:

- `BeforeAgentStartEvent` is a union of:
  - `BeforeAgentStartUserEvent` = `{ type, messageType: "user", prompt, images?,
    systemPrompt (readonly), systemPromptOptions }`
  - `BeforeAgentStartCustomEvent` = `{ type, messageType: "custom", message,
    systemPrompt, systemPromptOptions }`
- `systemPromptOptions` is `NormalizedBuildSystemPromptOptions`
  (`BuildSystemPromptOptions` with all collections complete). It has a mutable
  `sections: Record<string, string>` map. Assigning `sections.<name> = text`
  adds a `<name>`-tagged section to the system prompt; later handlers observe
  earlier mutations. Set it to `undefined`/`delete` to remove.
- Alternative full replacement: return `{ systemPrompt: "..." }` from the
  handler (or set `systemPromptOptions.forceSystemPrompt`). Prefer section
  mutation so Pi can emit transcript deltas.
- `BuildSystemPromptOptions` also has `appendSystemPrompt` (string) and
  `promptGuidelines` (string[]), but section mutation is the cleanest hook.
- Do **not** rely on the user's `APPEND_SYSTEM.md`. The extension injects its
  own instructions.

### Retrieval injection plan (first user message only)

1. On `session_start`, reset a per-session flag `hasSearched = false`.
2. On `before_agent_start` where `messageType === "user"` and `!hasSearched`:
   - run the search exactly once,
   - set `event.systemPromptOptions.sections.memory_retrieval = <previews>`,
   - set `hasSearched = true` so later turns in the same session do not search.
3. `search_memory` returns file paths + scores only (never contents); the
   injected block contains top paths + short previews so the model can open hits
   with the built-in `read` tool.

## 4. Package manifest format

`package.json` uses a `pi` key. Paths are relative to the package root and
accept globs/exclusions.

```json
{
  "name": "semantic_memory",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"],
    "prompts": ["./prompts/*.md"],
    "skills": ["./resources/skills"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Key facts:

- Without a `pi` manifest, Pi auto-discovers `extensions/`, `skills/`, `prompts/`,
  and `themes/` directories. With `src/index.ts` as the entry, the explicit
  `pi.extensions` array is required.
- An extension entry point is a file exporting a default factory
  `export default function (pi: ExtensionAPI) { ... }` (sync or async).
- Host-provided packages MUST be listed in `peerDependencies` with `"*"` and must
  NOT be in `dependencies`:
  `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.
- `pi install "$PWD"` installs a local package from the resolved path (no copy);
  local package dependency trees are the author's responsibility. `pi list` shows
  installed packages, `pi remove <source>` removes one.
- `prompts/*.md` resources become `/` slash-command prompt templates. We do NOT
  rely on that for `memory-instructions.md`; the extension reads the file and
  injects it into the system prompt directly (see §3).

## 5. Driving Pi non-interactively

Yes, Pi can be driven non-interactively. Four ways:

1. **Print mode** — `pi --print "prompt"` (or `-p`): runs the prompt, writes the
   final assistant text to stdout, exits. Nonzero exit on error/aborted
   (`length` stop also nonzero). Non-TTY stdin/stdout auto-selects print mode.
2. **JSON mode** — `pi --mode json "prompt"`: streams JSONL events then exits.
3. **RPC mode** — `pi --mode rpc --no-session`: long-lived JSONL control; use
   `RpcClient` from the SDK for typed access.
4. **SDK** (in-process) — `createAgentSession()` then `await session.prompt(...)`,
   `session.getLastAssistantText()`, `session.subscribe(...)`,
   `session.dispose()`. Configure with `DefaultResourceLoader({ cwd, agentDir,
   additionalExtensionPaths, extensionFactories })` and
   `SessionManager.inMemory()`.

For `check-goal.ts` we use: `pi install "$PWD"` for the load check, `pi --print`
for smoke checks where a model is available, and direct module imports (via
`tsx`) plus the SDK for mechanism-level checks that don't require a real model.

## 6. Embedding endpoint (Ollama)

- Confirmed tag: `embeddinggemma` — `ollama pull embeddinggemma`.
- Ollama's native embed endpoint: `POST {base}/api/embed` with body
  `{ "model": "embeddinggemma", "input": "text" }`, response
  `{ "embeddings": [[...]] }`.
- OpenAI-compatible alternative: `POST {base}/v1/embeddings` with
  `{ "model", "input" }`, response `{ "data": [{ "embedding": [...] }] }`.
- Env vars used by this extension: `SEMANTIC_MEMORY_EMBED_URL`
  (default `http://localhost:11434`) and `SEMANTIC_MEMORY_EMBED_MODEL`
  (default `embeddinggemma`).

## 7. Concurrency / safety notes

- Tool calls from one assistant message can run in parallel; `save_memory` and
  `search_memory` both mutate/read the index. Wrap read-modify-write of
  `.index.json` in Pi's `withFileMutationQueue()` (re-exported from the SDK) or
  an internal mutex so concurrent saves don't corrupt the index.
- Keep tool results small and truncate; the model opens files with `read`.
- Extensions load in interactive, RPC, JSON, and print modes; guard TUI-only
  behavior with `ctx.mode === "tui"` / `ctx.hasUI`.
