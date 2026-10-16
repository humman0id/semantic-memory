#!/usr/bin/env node
/**
 * check-goal.ts — verify each GOAL.md criterion. Exits non-zero while any fail.
 *
 * Run: npx tsx scripts/check-goal.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Embedder, EmbedderStatus, OllamaEmbedderOptions } from "../src/embed.ts";
import type { PreflightResult } from "../src/preflight.ts";
import type { SearchResult } from "../src/search.ts";
import type { IndexQueue, MemoryIndex, MemoryNote, PossibleDupes } from "../src/store.ts";
import type { MemoryToolCore, RetrievalController, SaveMemoryToolResult } from "../src/index.ts";

type IndexModule = {
  createMemoryToolCore(deps: {
    embedder: Embedder;
    topK?: number;
    previewLength?: number;
    dupScore?: number;
    similarScore?: number;
    minScore?: number;
  }): MemoryToolCore;
  createRetrievalController(deps: {
    search(query: string, topK: number, minScore?: number): Promise<SearchResult[]>;
    readNote(filePath: string): MemoryNote | undefined;
    topK?: number;
    previewLength?: number;
    minScore?: number;
  }): RetrievalController;
};
type EmbedModule = {
  createOllamaEmbedder(options?: OllamaEmbedderOptions): Embedder;
  probeEmbedder(embedder: Embedder): Promise<EmbedderStatus>;
};
type PreflightModule = { preflight(embedder: Embedder): Promise<PreflightResult> };
type StoreModule = {
  readIndex(): MemoryIndex;
  readQueue(): IndexQueue;
  readPossibleDupes(): PossibleDupes;
  readNote(filePath: string): MemoryNote | undefined;
  listMemories(): MemoryNote[];
};

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

interface CheckResult {
  criterion: string;
  ok: boolean;
  skipped?: boolean;
  details: string;
}

function run(cmd: string, args: string[], cwd = ROOT): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function importSrc<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(path.join(ROOT, "src", name)).href)) as T;
}

function newTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "semantic-memory-"));
  process.env.SEMANTIC_MEMORY_DIR = dir;
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function mapEmbedder(vectors: Record<string, number[]>): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      return vectors[text] ?? [0, 0, 0];
    },
  };
}

// ---------------------------------------------------------------- criterion 1
async function check1(): Promise<CheckResult> {
  const lint = run("npm", ["run", "lint"]);
  const test = run("npm", ["run", "test"]);
  const ok = lint.status === 0 && test.status === 0;
  return {
    criterion: "1. lint + unit tests pass",
    ok,
    details: `lint=${lint.status} test=${test.status}\n${lint.out}\n${test.out}`.slice(0, 4000),
  };
}

// ---------------------------------------------------------------- criterion 2
async function check2(): Promise<CheckResult> {
  const lines: string[] = [];
  const inst = run("pi", ["install", ROOT]);
  const instOk = inst.status === 0 && !/error|failed|cannot/i.test(inst.out);
  lines.push(`pi install exit=${inst.status}`);
  lines.push(inst.out);

  let loadOk = false;
  try {
    const { DefaultResourceLoader, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const entry = path.join(ROOT, "src", "index.ts");
    const loader = new DefaultResourceLoader({
      cwd: ROOT,
      agentDir: getAgentDir(),
      additionalExtensionPaths: [entry],
    });
    await loader.reload();
    const res = loader.getExtensions();
    const mine = res.errors.filter(
      (e: { path: string; error: string }) =>
        path.resolve(e.path) === path.resolve(entry) || e.path.includes("src/index.ts"),
    );
    loadOk = mine.length === 0;
    if (!loadOk) {
      lines.push("extension load errors:");
      for (const e of mine) lines.push(`  ${e.path}: ${e.error}`);
    } else {
      lines.push("extension loaded without errors (SDK check)");
    }
  } catch (err) {
    loadOk = false;
    lines.push(`SDK load check threw: ${(err as Error).message}`);
  }

  return { criterion: "2. pi install loads the extension without errors", ok: instOk && loadOk, details: lines.join("\n") };
}

// ---------------------------------------------------------------- criterion 3
async function check3(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { readIndex } = await importSrc<StoreModule>("store.ts");
    const fake: Embedder = { embed: async (t: string) => new Array<number>(16).fill(t.length) };
    const core = createMemoryToolCore({ embedder: fake });
    const res: SaveMemoryToolResult = await core.saveMemory("User prefers tabs over spaces.", ["preference", "style"]);

    const fileOk = existsSync(res.filePath ?? "");
    const raw = fileOk ? readFileSync(res.filePath ?? "", "utf8") : "";
    const fmOk = raw.startsWith("---") && /id:\s*\S+/.test(raw) && /created:\s*\S+/.test(raw) && /tags:/.test(raw);
    const bodyOk = raw.includes("User prefers tabs over spaces.");
    const idx = readIndex();
    const indexed = idx.entries.some((e) => e.filePath === res.filePath && e.vector.length === 16);
    const ok = fileOk && fmOk && bodyOk && res.indexed && indexed && !res.queued && res.status === "saved";
    return {
      criterion: "3. save_memory writes .md with frontmatter and indexes it",
      ok,
      details: `fileOk=${fileOk} frontmatterOk=${fmOk} bodyOk=${bodyOk} status=${res.status} indexed=${res.indexed} indexEntryOk=${indexed}\n${raw}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 4
async function check4(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createOllamaEmbedder, probeEmbedder } = await importSrc<EmbedModule>("embed.ts");
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const embedder = createOllamaEmbedder();
    const status = await probeEmbedder(embedder);
    if (!status.available) {
      return {
        criterion: "4. search_memory returns right path for paraphrased query (real Ollama)",
        ok: true,
        skipped: true,
        details: `Ollama unavailable: ${status.error ?? "unknown"} — skipped`,
      };
    }
    const core = createMemoryToolCore({ embedder });
    const a = await core.saveMemory("The project uses Vitest for unit testing.", ["testing"]);
    const b = await core.saveMemory("Deployment targets a single Node server.", ["deploy"]);
    const hits = await core.searchMemory("what framework runs the tests?", 5);
    const top = hits[0]?.filePath;
    const ok = top === a.filePath && a.filePath !== b.filePath && hits.every((h) => !("content" in h));
    return {
      criterion: "4. search_memory returns right path for paraphrased query (real Ollama)",
      ok,
      details: `top=${top} expected=${a.filePath}\n${JSON.stringify(hits, null, 2)}`,
    };
  } catch (err) {
    return {
      criterion: "4. search_memory returns right path for paraphrased query (real Ollama)",
      ok: false,
      details: `threw: ${(err as Error).message}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 5
async function check5(): Promise<CheckResult> {
  const { createRetrievalController } = await importSrc<IndexModule>("index.ts");
  let calls = 0;
  const ctrl = createRetrievalController({
    search: async () => {
      calls += 1;
      return [{ filePath: "/tmp/example-note.md", score: 0.91 }];
    },
    readNote: (filePath: string) =>
      filePath === "/tmp/example-note.md"
        ? { id: "example", filePath, created: new Date().toISOString(), tags: [], content: "User prefers tabs", hash: "h" }
        : undefined,
    topK: 5,
  });
  const first = await ctrl.onUserTurn("what do I prefer?");
  const second = await ctrl.onUserTurn("another message in the same session");
  const ok = calls === 1 && first.includes("/tmp/example-note.md") && second === "";
  return {
    criterion: "5. first message triggers exactly one search and injects top paths",
    ok,
    details: `searchCalls=${calls} firstBlockHasPath=${first.includes("/tmp/example-note.md")} secondBlockEmpty=${second === ""}\nfirst block:\n${first}`,
  };
}

// ---------------------------------------------------------------- criterion 6
async function check6(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createOllamaEmbedder } = await importSrc<EmbedModule>("embed.ts");
    const { preflight } = await importSrc<PreflightModule>("preflight.ts");
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { readQueue } = await importSrc<StoreModule>("store.ts");
    const embedder = createOllamaEmbedder({ baseUrl: "http://127.0.0.1:1" }); // unreachable
    const pr = await preflight(embedder);
    const msgOk = !pr.ok && !!pr.message && pr.message.includes("ollama pull embeddinggemma");
    const core = createMemoryToolCore({ embedder });
    const res = await core.saveMemory("Still saved while Ollama is down", ["resilience"]);
    const fileOk = existsSync(res.filePath ?? "");
    const queued = readQueue().files.includes(res.filePath ?? "");
    const ok = msgOk && fileOk && res.status === "queued" && res.queued && !res.indexed && queued;
    return {
      criterion: "6. with Ollama stopped: clear message, save writes + queues",
      ok,
      details: `preflightOk=${pr.ok} message=${pr.message ?? ""} msgOk=${msgOk} fileOk=${fileOk} queued=${queued} res=${JSON.stringify(res)}`,
    };
  } catch (err) {
    return {
      criterion: "6. with Ollama stopped: clear message, save writes + queues",
      ok: false,
      details: `threw: ${(err as Error).message}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 7
async function check7(): Promise<CheckResult> {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const hasInstall = /##\s*Install/i.test(readme) && /pi install/i.test(readme);
  const hasConfig = /##\s*Config/i.test(readme) && /SEMANTIC_MEMORY_EMBED_URL/i.test(readme);
  const hasUsage = /##\s*Usage/i.test(readme) && readme.includes("save_memory(") && readme.includes("search_memory(");
  const ok = hasInstall && hasConfig && hasUsage;
  return {
    criterion: "7. README has install, config, and usage example",
    ok,
    details: `install=${hasInstall} config=${hasConfig} usage=${hasUsage}`,
  };
}

// ---------------------------------------------------------------- criterion 8
async function check8(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { listMemories } = await importSrc<StoreModule>("store.ts");

    // mocked embedder: near-identical vectors => duplicate, one file
    const fake = mapEmbedder({ "tabs over spaces": [1, 0], "tabs rather than spaces": [0.99, 0.1] });
    const core = createMemoryToolCore({ embedder: fake, dupScore: 0.9, similarScore: 0.6 });
    const a = await core.saveMemory("tabs over spaces", ["pref"]);
    const b = await core.saveMemory("tabs rather than spaces", ["pref"]);
    const mockedOk = a.status === "saved" && b.status === "duplicate" && b.filePath === a.filePath && listMemories().length === 1;

    // real Ollama: identical content twice => duplicate
    const { createOllamaEmbedder, probeEmbedder } = await importSrc<EmbedModule>("embed.ts");
    const real = createOllamaEmbedder();
    const status = await probeEmbedder(real);
    if (!status.available) {
      return {
        criterion: "8. near-identical save twice yields one file + duplicate result",
        ok: mockedOk,
        skipped: !mockedOk ? false : true,
        details: `mockedOk=${mockedOk}\nOllama unavailable: ${status.error ?? "unknown"} — real integration skipped`,
      };
    }
    const rcore = createMemoryToolCore({ embedder: real });
    const x = await rcore.saveMemory("The project uses Vitest as its test runner.", ["testing"]);
    const y = await rcore.saveMemory("The project uses Vitest as its test runner.", ["testing"]);
    const realOk = y.status === "duplicate" && y.filePath === x.filePath;
    const ok = mockedOk && realOk;
    return {
      criterion: "8. near-identical save twice yields one file + duplicate result",
      ok,
      details: `mockedOk=${mockedOk} realOk=${realOk}\ny=${JSON.stringify(y)}`,
    };
  } catch (err) {
    return { criterion: "8. near-identical save twice yields one file + duplicate result", ok: false, details: `threw: ${(err as Error).message}` };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 9
async function check9(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { listMemories } = await importSrc<StoreModule>("store.ts");
    const fake = mapEmbedder({ "prefers npm": [1, 0], "prefers pnpm": [0.7, 0.7] });
    const core = createMemoryToolCore({ embedder: fake, dupScore: 0.95, similarScore: 0.6 });

    const a = await core.saveMemory("prefers npm", []);
    const b = await core.saveMemory("prefers pnpm", []);
    const similarOk = a.status === "saved" && b.status === "similar" && (b.candidates?.length ?? 0) >= 1 && listMemories().length === 1;

    const c = await core.saveMemory("prefers pnpm", [], true);
    const allowNewOk = c.status === "saved" && listMemories().length === 2;
    const ok = similarOk && allowNewOk;
    return {
      criterion: "9. similar save writes nothing + returns candidates; allowNew writes",
      ok,
      details: `similarOk=${similarOk} allowNewOk=${allowNewOk}\nb=${JSON.stringify(b)}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 10
async function check10(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { readNote } = await importSrc<StoreModule>("store.ts");
    const fake = mapEmbedder({ old: [1, 0], new: [0, 1] });
    const core = createMemoryToolCore({ embedder: fake });

    const saved = await core.saveMemory("old", ["t"]);
    const before = readNote(saved.filePath ?? "")!;
    const upd = await core.updateMemory(saved.filePath!, "new", ["t2"]);
    const after = readNote(saved.filePath ?? "")!;
    const archiveOk = upd.ok && existsSync(upd.archivePath ?? "") && readFileSync(upd.archivePath ?? "", "utf8").includes("old");
    const fieldsOk = after.id === before.id && after.created === before.created && after.updated !== undefined && after.content === "new" && JSON.stringify(after.tags) === JSON.stringify(["t2"]);

    const hits = await core.searchMemory("new", 5);
    const searchOk = hits.some((h) => h.filePath === saved.filePath);

    const outside = await core.updateMemory(path.join(dir, "..", "escape.md"), "x");
    const txt = path.join(dir, "note.txt");
    writeFileSync(txt, "x");
    const nonMd = await core.updateMemory(txt, "x");
    const archiveReject = await core.updateMemory(upd.archivePath ?? "", "x");
    const rejectOk = !outside.ok && !nonMd.ok && !archiveReject.ok;

    const ok = archiveOk && fieldsOk && searchOk && rejectOk;
    return {
      criterion: "10. update_memory replaces/preserves/archives/re-indexes and rejects bad paths",
      ok,
      details: `archiveOk=${archiveOk} fieldsOk=${fieldsOk} searchOk=${searchOk} rejectOk=${rejectOk}\nupd=${JSON.stringify(upd)}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 11
async function check11(): Promise<CheckResult> {
  const { createRetrievalController, createMemoryToolCore } = await importSrc<IndexModule>("index.ts");

  let sawMin: number | undefined;
  const ctrl = createRetrievalController({
    search: async (_q: string, _k: number, minScore?: number) => {
      sawMin = minScore;
      const all = [
        { filePath: "/tmp/low.md", score: 0.2 },
        { filePath: "/tmp/high.md", score: 0.9 },
      ];
      return all.filter((h) => h.score >= (minScore ?? 0));
    },
    readNote: () => undefined,
    minScore: 0.5,
    topK: 5,
  });
  const block = await ctrl.onUserTurn("hello");
  const injectedOk = sawMin === 0.5 && block.includes("/tmp/high.md") && !block.includes("/tmp/low.md");

  const ctrl2 = createRetrievalController({ search: async () => [], readNote: () => undefined, minScore: 0.5 });
  const emptyOk = (await ctrl2.onUserTurn("hello")) === "";

  const dir = newTempDir();
  try {
    const core = createMemoryToolCore({ embedder: mapEmbedder({ query: [1, 0], one: [1, 0], two: [0, 1] }) });
    await core.saveMemory("one", []);
    await core.saveMemory("two", []);
    const hits = await core.searchMemory("query", 10);
    const scoredOk = hits.length === 2 && hits.every((h) => typeof h.score === "number");
    const ok = injectedOk && emptyOk && scoredOk;
    return {
      criterion: "11. injection honors MIN_SCORE; search_memory returns scored results",
      ok,
      details: `injectedOk=${injectedOk} emptyOk=${emptyOk} scoredOk=${scoredOk}\nblock:\n${block}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 12
async function check12(): Promise<CheckResult> {
  const decisions = readFileSync(path.join(ROOT, "docs", "decisions.md"), "utf8");
  const indexSrc = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
  const hasScript = existsSync(path.join(ROOT, "scripts", "calibrate-thresholds.ts"));
  const hasDecisions =
    decisions.includes("embeddinggemma") &&
    decisions.includes("0.95") &&
    decisions.includes("0.62") &&
    decisions.includes("0.44");
  const defaultsMatch =
    indexSrc.includes('envFloat("SEMANTIC_MEMORY_DUP_SCORE", 0.95)') &&
    indexSrc.includes('envFloat("SEMANTIC_MEMORY_SIMILAR_SCORE", 0.62)') &&
    indexSrc.includes('envFloat("SEMANTIC_MEMORY_MIN_SCORE", 0.44)');
  const ok = hasScript && hasDecisions && defaultsMatch;
  return {
    criterion: "12. calibration recorded in decisions.md and code defaults match",
    ok,
    details: `hasScript=${hasScript} hasDecisions=${hasDecisions} defaultsMatch=${defaultsMatch}`,
  };
}

// ---------------------------------------------------------------- criterion 13
async function check13(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { readPossibleDupes, readIndex } = await importSrc<StoreModule>("store.ts");

    const vecs: Record<string, number[]> = { "existing fact": [1, 0], "queued similar": [0.9, 0.4] };
    const working = mapEmbedder(vecs);
    const good = createMemoryToolCore({ embedder: working, similarScore: 0.6 });
    await good.saveMemory("existing fact", []);

    const down: Embedder = { embed: async () => { throw new Error("down"); } };
    const downCore = createMemoryToolCore({ embedder: down });
    const queuedRes = await downCore.saveMemory("queued similar", []);
    const okDown = queuedRes.status === "queued" && queuedRes.queued && existsSync(queuedRes.filePath ?? "");

    const recovered = createMemoryToolCore({ embedder: working, similarScore: 0.6 });
    const outcome = await recovered.processPending();

    const dupes = readPossibleDupes();
    const recordedOk = outcome.possibleDupes === 1 && dupes.entries.length === 1 && dupes.entries[0]!.filePath === queuedRes.filePath;
    const notDeletedOk = existsSync(queuedRes.filePath ?? "");
    const notIndexedOk = readIndex().entries.length === 1; // only "existing fact"
    const ok = okDown && recordedOk && notDeletedOk && notIndexedOk;
    return {
      criterion: "13. queue processing records possible dupes instead of deleting",
      ok,
      details: `okDown=${okDown} recordedOk=${recordedOk} notDeletedOk=${notDeletedOk} notIndexedOk=${notIndexedOk}\noutcome=${JSON.stringify(outcome)}`,
    };
  } finally {
    cleanup(dir);
  }
}

async function main(): Promise<void> {
  const factories = [check1, check2, check3, check4, check5, check6, check7, check8, check9, check10, check11, check12, check13];
  const checks: CheckResult[] = [];
  for (const f of factories) {
    try {
      checks.push(await f());
    } catch (err) {
      checks.push({ criterion: `check crashed (${f.name})`, ok: false, details: (err as Error).message });
    }
  }
  let failed = 0;
  for (const c of checks) {
    const tag = c.skipped ? "SKIP" : c.ok ? "PASS" : "FAIL";
    console.log(`[${tag}] ${c.criterion}`);
    if (!c.ok || c.skipped) console.log(indent(c.details));
  }
  for (const c of checks) if (!c.ok && !c.skipped) failed += 1;
  console.log(`\n${checks.length - failed}/${checks.length} criteria passing (${checks.filter((c) => c.skipped).length} skipped)`);
  process.exit(failed > 0 ? 1 : 0);
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

main().catch((err) => {
  console.error("check-goal crashed:", err);
  process.exit(1);
});
