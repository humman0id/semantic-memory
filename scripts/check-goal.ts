#!/usr/bin/env node
/**
 * check-goal.ts — verify each GOAL.md criterion. Exits non-zero while any fail.
 *
 * Run: npx tsx scripts/check-goal.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Embedder, EmbedderStatus, OllamaEmbedderOptions } from "../src/embed.ts";
import type { PreflightResult } from "../src/preflight.ts";
import type { SearchResult } from "../src/search.ts";
import type { IndexQueue, MemoryIndex, MemoryNote } from "../src/store.ts";
import type { MemoryToolCore, RetrievalController, SaveMemoryToolResult } from "../src/index.ts";

type IndexModule = {
  createMemoryToolCore(deps: { embedder: Embedder; topK?: number; previewLength?: number }): MemoryToolCore;
  createRetrievalController(deps: {
    search(query: string, topK: number): Promise<SearchResult[]>;
    readNote(filePath: string): MemoryNote | undefined;
    topK?: number;
    previewLength?: number;
  }): RetrievalController;
};
type EmbedModule = {
  createOllamaEmbedder(options?: OllamaEmbedderOptions): Embedder;
  probeEmbedder(embedder: Embedder): Promise<EmbedderStatus>;
};
type PreflightModule = { preflight(embedder: Embedder): Promise<PreflightResult> };
type StoreModule = { readIndex(): MemoryIndex; readQueue(): IndexQueue };

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

function tempMemoryDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "semantic-memory-"));
  process.env.SEMANTIC_MEMORY_DIR = dir;
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
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
  const dir = tempMemoryDir();
  try {
    const { createMemoryToolCore } = await importSrc<IndexModule>("index.ts");
    const { readIndex } = await importSrc<StoreModule>("store.ts");
    const fake: Embedder = { embed: async (t: string) => new Array<number>(16).fill(t.length) };
    const core = createMemoryToolCore({ embedder: fake });
    const res: SaveMemoryToolResult = await core.saveMemory("User prefers tabs over spaces.", ["preference", "style"]);

    const fileOk = existsSync(res.filePath);
    const raw = fileOk ? readFileSync(res.filePath, "utf8") : "";
    const fmOk = raw.startsWith("---") && /id:\s*\S+/.test(raw) && /created:\s*\S+/.test(raw) && /tags:/.test(raw);
    const bodyOk = raw.includes("User prefers tabs over spaces.");
    const idx = readIndex();
    const indexed = idx.entries.some((e) => e.filePath === res.filePath && e.vector.length === 16);
    const ok = fileOk && fmOk && bodyOk && res.indexed && indexed && !res.queued;
    return {
      criterion: "3. save_memory writes .md with frontmatter and indexes it",
      ok,
      details: `fileOk=${fileOk} frontmatterOk=${fmOk} bodyOk=${bodyOk} indexed=${res.indexed} indexEntryOk=${indexed}\n${raw}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 4
async function check4(): Promise<CheckResult> {
  const dir = tempMemoryDir();
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
  const dir = tempMemoryDir();
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
    const fileOk = existsSync(res.filePath);
    const queued = readQueue().files.includes(res.filePath);
    const ok = msgOk && fileOk && res.queued && !res.indexed && queued;
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

async function main(): Promise<void> {
  const factories = [check1, check2, check3, check4, check5, check6, check7];
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
