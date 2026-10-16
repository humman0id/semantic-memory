#!/usr/bin/env node
/**
 * check-goal.ts — verify each GOAL.md criterion. Exits non-zero while any fail.
 *
 * Run: npx tsx scripts/check-goal.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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
  renderSaveResult(res: SaveMemoryToolResult): string;
  DUPLICATE_INSTRUCTION: string;
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
    decisions.includes("0.97") &&
    decisions.includes("0.59") &&
    decisions.includes("0.44");
  const defaultsMatch =
    indexSrc.includes('envFloat("SEMANTIC_MEMORY_DUP_SCORE", 0.97)') &&
    indexSrc.includes('envFloat("SEMANTIC_MEMORY_SIMILAR_SCORE", 0.59)') &&
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

// ---------------------------------------------------------------- criterion 14
async function check14(): Promise<CheckResult> {
  const dir = newTempDir();
  try {
    const { createMemoryToolCore, renderSaveResult, DUPLICATE_INSTRUCTION } = await importSrc<IndexModule>("index.ts");
    const { readNote } = await importSrc<StoreModule>("store.ts");
    const fake = mapEmbedder({ fact: [1, 0], "fact reworded": [0.99, 0.1] });
    const core = createMemoryToolCore({ embedder: fake, dupScore: 0.9, similarScore: 0.6 });

    const a = await core.saveMemory("fact", []);
    const b = await core.saveMemory("fact reworded", []);

    const shapeOk =
      b.status === "duplicate" &&
      b.filePath === a.filePath &&
      typeof b.score === "number" &&
      typeof b.preview === "string" &&
      (b.preview?.length ?? 0) > 0;
    const text = renderSaveResult(b);
    const instructionOk = text.includes(b.filePath ?? "") && text.includes(DUPLICATE_INSTRUCTION);
    const noTouchOk = readNote(a.filePath ?? "")?.updated === undefined;

    const ok = shapeOk && instructionOk && noTouchOk;
    return {
      criterion: "14. duplicate result includes path/score/preview + update_memory instruction",
      ok,
      details: `shapeOk=${shapeOk} instructionOk=${instructionOk} noTouchOk=${noTouchOk}\n${text}`,
    };
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- criterion 15
async function check15(): Promise<CheckResult> {
  const decisions = readFileSync(path.join(ROOT, "docs", "decisions.md"), "utf8");
  const indexSrc = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");

  const maxChange = /max change\/contradiction score \(([\d.]+)\)/i.exec(decisions)?.[1];
  const margin = /recorded margin \(([\d.]+)\)/.exec(decisions)?.[1];
  const dup = /`SEMANTIC_MEMORY_DUP_SCORE`\s*\|\s*`([\d.]+)`/.exec(decisions)?.[1];
  const indexDup = /envFloat\("SEMANTIC_MEMORY_DUP_SCORE",\s*([\d.]+)\)/.exec(indexSrc)?.[1];

  const parsed = [maxChange, margin, dup, indexDup].every((v) => v !== undefined);
  const marginOk = parsed && Number(dup) >= Number(maxChange) + Number(margin) - 0.005;
  const codeMatch = parsed && dup === indexDup;
  const ok = parsed && marginOk && codeMatch;
  return {
    criterion: "15. DUP_SCORE exceeds max change/contradiction score by recorded margin",
    ok,
    details: `maxChange=${maxChange} margin=${margin} dup=${dup} indexDup=${indexDup} marginOk=${marginOk} codeMatch=${codeMatch}`,
  };
}

// ---------------------------------------------------------------- criterion 16
async function check16(): Promise<CheckResult> {
  const tracked = run("git", ["ls-files"]).out.trim().split("\n").filter(Boolean);
  const username = userInfo().username;

  const forbiddenNames = [".env", ".index.json", ".queue.json", ".possible-dupes.json", "MEMORY.md", ".archive/"];
  const nameHits = tracked.filter((f) => forbiddenNames.some((n) => f.includes(n)));

  const secretPatterns = [
    /ghp_[A-Za-z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /xox[bap]-[A-Za-z0-9-]+/,
    /sk-[A-Za-z0-9]{20,}/,
  ];
  const pathHits: string[] = [];
  const secretHits: string[] = [];
  const usernameHits: string[] = [];

  for (const f of tracked) {
    if (f.startsWith("scripts/") || f === "package-lock.json") continue;
    let content: string;
    try {
      content = readFileSync(path.join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    if (/\/Users\/|\/home\/[a-z]/.test(content)) pathHits.push(f);
    if (username && content.includes(username)) usernameHits.push(f);
    if (secretPatterns.some((re) => re.test(content))) secretHits.push(f);
  }

  const progress = readFileSync(path.join(ROOT, "docs", "progress.md"), "utf8");
  const reported = /[Ss]crub/.test(progress);

  const ok =
    nameHits.length === 0 && pathHits.length === 0 && secretHits.length === 0 && usernameHits.length === 0 && reported;
  return {
    criterion: "16. scrub: no absolute paths/secrets/memory files; history findings reported",
    ok,
    details: `tracked=${tracked.length} nameHits=${JSON.stringify(nameHits)} pathHits=${JSON.stringify(pathHits)} secretHits=${JSON.stringify(secretHits)} usernameHits=${JSON.stringify(usernameHits)} reportedInProgress=${reported}`,
  };
}

// ---------------------------------------------------------------- criterion 17
async function check17(): Promise<CheckResult> {
  const pack = run("npm", ["pack", "--dry-run"]);
  const out = pack.out;
  const forbidden = [
    "test/",
    "scripts/",
    "docs/",
    "GOAL.md",
    "AGENTS.md",
    "package-lock.json",
    "calibrate-thresholds",
    "progress.md",
    "contracts.md",
    "decisions.md",
    "pi-notes.md",
    "find-duplicates",
    "check-goal",
    ".env",
  ];
  const hasForbidden = forbidden.filter((s) => out.includes(s));
  const required = ["LICENSE", "README.md", "package.json", "src/", "prompts/memory-instructions.md"];
  const missing = required.filter((s) => !out.includes(s));
  const ok = pack.status === 0 && hasForbidden.length === 0 && missing.length === 0;
  return {
    criterion: "17. npm pack --dry-run file list matches allowlist",
    ok,
    details: `exit=${pack.status} forbidden=${JSON.stringify(hasForbidden)} missing=${JSON.stringify(missing)}\n${out}`,
  };
}

// ---------------------------------------------------------------- criterion 18
async function check18(): Promise<CheckResult> {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const sections = [
    "## Requirements",
    "## Install",
    "## Configure",
    "## How it works",
    "## Security",
    "## Limitations",
    "## Design notes",
  ];
  const missingSections = sections.filter((s) => !readme.includes(s));
  const envVars = [
    "SEMANTIC_MEMORY_EMBED_URL",
    "SEMANTIC_MEMORY_EMBED_MODEL",
    "SEMANTIC_MEMORY_DIR",
    "SEMANTIC_MEMORY_DUP_SCORE",
    "SEMANTIC_MEMORY_SIMILAR_SCORE",
    "SEMANTIC_MEMORY_MIN_SCORE",
  ];
  const missingVars = envVars.filter((v) => !readme.includes(v));
  const tools = ["save_memory", "search_memory", "update_memory", "allowNew"];
  const missingTools = tools.filter((t) => !readme.includes(t));
  const numbers = ["0.97", "0.59", "0.44", "0.944", "0.03", "0.730", "0.961", "0.826"];
  const missingNumbers = numbers.filter((n) => !readme.includes(n));
  const stale = ["0.95", "0.62"].filter((n) => readme.includes(n));
  const gitUrlOk = readme.includes("git:github.com/humman0id/semantic-memory");
  const flowTextOk = readme.includes("**Flow:**") && readme.includes("**Dedupe");
  const hasOllama = readme.includes("ollama pull embeddinggemma") && readme.includes("embeddinggemma");
  const ok =
    missingSections.length === 0 &&
    missingVars.length === 0 &&
    missingTools.length === 0 &&
    missingNumbers.length === 0 &&
    stale.length === 0 &&
    gitUrlOk &&
    flowTextOk &&
    hasOllama;
  return {
    criterion: "18. README has all sections, flow/dedupe explained, no unverified claims",
    ok,
    details: `missingSections=${JSON.stringify(missingSections)} missingVars=${JSON.stringify(missingVars)} missingTools=${JSON.stringify(missingTools)} missingNumbers=${JSON.stringify(missingNumbers)} stale=${JSON.stringify(stale)} gitUrlOk=${gitUrlOk} flowTextOk=${flowTextOk} hasOllama=${hasOllama}`,
  };
}

// ---------------------------------------------------------------- criterion 19
async function check19(): Promise<CheckResult> {
  const env = { ...process.env, SEMANTIC_MEMORY_EMBED_URL: "http://127.0.0.1:1" };
  const opts = { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", env } as const;
  const lint = spawnSync("npm", ["run", "lint"], opts);
  const test = spawnSync("npm", ["run", "test"], opts);
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], opts);
  const ok = lint.status === 0 && test.status === 0 && tsc.status === 0;
  return {
    criterion: "19. lint + tests pass with Ollama unreachable (CI-equivalent)",
    ok,
    details: `lint=${lint.status} test=${test.status} tsc=${tsc.status}\n${test.stdout ?? ""}${test.stderr ?? ""}`.slice(0, 2000),
  };
}

async function main(): Promise<void> {
  const factories = [check1, check2, check3, check4, check5, check6, check7, check8, check9, check10, check11, check12, check13, check14, check15, check16, check17, check18, check19];
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
