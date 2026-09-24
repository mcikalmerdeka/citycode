import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { POST } from "../app/api/analyze/route";
import { compareSummarySlot, snapshotFileName, snapshotFilePath } from "../lib/snapshot/key";
import { localWalkFingerprint } from "../lib/snapshot/fingerprint";
import { loadSnapshot } from "../lib/snapshot/load";
import { carryOverSummaries, saveSnapshot } from "../lib/snapshot/save";
import { SNAPSHOT_VERSION, isSnapshot, type Snapshot } from "../lib/snapshot/schema";
import { parseLsRemoteHead } from "../lib/git/clone";
import { resetStoresForTests } from "../lib/llm/graphCache";
import { computeRepoKey } from "../lib/repoKey";
import type { CodeGraph } from "../lib/types";
import { cleanup, initRepo, makeTempDir, writeFiles } from "./helpers/fixtures";

/**
 * Phase 6 — snapshots. Unit tests for the snapshot layer (key derivation,
 * fingerprint, atomic save/load, corruption handling, summary carry-over)
 * plus route-level integration against /api/analyze's POST handler,
 * covering the plan's acceptance items:
 * 1. regenerate the same repo → served from snapshot (`fromCache: true`),
 *    graph + layout byte-identical;
 * 2. a new commit → cache invalidated, fresh graph;
 * 4. corrupt snapshot → detected, silently regenerated.
 */

const dirs: string[] = [];
const snapshotFiles: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
  // Snapshots live under .citycode-cache/snapshots (gitignored) — remove
  // exactly what this test created so the suite stays hermetic.
  for (const file of snapshotFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
  snapshotFiles.length = 0;
  resetStoresForTests();
});

/* ------------------------------------------------------------------ *
 * key.ts — cache-key derivation
 * ------------------------------------------------------------------ */

describe("snapshotFileName", () => {
  it("deterministically maps (repoKey, headSha) to one filename", () => {
    const a = snapshotFileName("local:E:/repos/demo", "abc123");
    const b = snapshotFileName("local:E:/repos/demo", "abc123");
    expect(a).toBe(b);
    expect(a).toMatch(/^local-[0-9a-f]{16}\.json$/);
  });

  it("distinguishes headSha and repoKey; undefined sha is its own state", () => {
    const base = snapshotFileName("local:E:/repos/demo", "abc123");
    expect(snapshotFileName("local:E:/repos/demo", "def456")).not.toBe(base);
    expect(snapshotFileName("local:E:/repos/demo")).not.toBe(base);
    expect(snapshotFileName("github:OTHER", "abc123")).toMatch(/^github-/);
    expect(snapshotFileName("local:E:/repos/demo")).toMatch(/^local-/);
  });
});

describe("compareSummarySlot", () => {
  it("slots by mode and state id", () => {
    expect(compareSummarySlot("prev", "abc")).toBe("prev:abc");
    expect(compareSummarySlot("prev", undefined)).toBe("prev:none");
    expect(compareSummarySlot("workdir", "hash1")).toBe("workdir:hash1");
    expect(compareSummarySlot("workdir", "hash1")).not.toBe(compareSummarySlot("prev", "hash1"));
  });
});

/* ------------------------------------------------------------------ *
 * schema.ts — corruption guard
 * ------------------------------------------------------------------ */

function minimalSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    source: "local",
    repoPathOrUrl: "E:/repos/demo",
    stateFingerprint: "fingerprint",
    fileStats: {},
    graph: { files: [], edges: [], repoPath: "E:/repos/demo", source: "local" },
    layout: { buildings: [], districts: [], roads: [], repoPath: "E:/repos/demo" } as Snapshot["layout"],
    warnings: [],
    llmSummaries: {},
    compareSummaries: {},
    createdAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("isSnapshot guard", () => {
  it("accepts a well-formed snapshot", () => {
    expect(isSnapshot(minimalSnapshot())).toBe(true);
  });

  it("rejects corrupt or wrong-version payloads", () => {
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot("not an object")).toBe(false);
    expect(isSnapshot(minimalSnapshot({ version: 99 }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ version: undefined as unknown as number }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ source: "svn" as Snapshot["source"] }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ stateFingerprint: undefined }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ graph: {} as Snapshot["graph"] }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ layout: { buildings: 3 } as unknown as Snapshot["layout"] }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ warnings: "none" as unknown as Snapshot["warnings"] }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ llmSummaries: [] as unknown as Snapshot["llmSummaries"] }))).toBe(false);
    expect(isSnapshot(minimalSnapshot({ createdAt: "not-a-date" }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * fingerprint.ts — local state freshness
 * ------------------------------------------------------------------ */

describe("localWalkFingerprint", () => {
  it("returns null for a missing folder", () => {
    expect(localWalkFingerprint(path.join(makeTempDir(), "does-not-exist"))).toBeNull();
  });

  it("is stable for an untouched tree and includes every source file", () => {
    const root = makeTempDir();
    dirs.push(root);
    writeFiles(root, [
      { path: "src/a.ts", contents: "export const a = 1;\n" },
      { path: "pkg/b.py", contents: "x = 1\n" },
    ]);
    const first = localWalkFingerprint(root);
    expect(first).not.toBeNull();
    const second = localWalkFingerprint(root);
    expect(second?.hash).toBe(first?.hash);
    expect(Object.keys(first?.entries ?? {}).sort()).toEqual(["pkg/b.py", "src/a.ts"]);
  });

  it("changes when a file's size or the set of files changes", () => {
    const root = makeTempDir();
    dirs.push(root);
    writeFiles(root, [{ path: "src/a.ts", contents: "export const a = 1;\n" }]);
    const base = localWalkFingerprint(root);

    // Same mtime, different size → different fingerprint (apending changes content)
    fs.appendFileSync(path.join(root, "src", "a.ts"), "// more\n");
    const afterEdit = localWalkFingerprint(root);
    expect(afterEdit?.hash).not.toBe(base?.hash);

    // New file → different fingerprint
    writeFiles(root, [{ path: "src/c.ts", contents: "export const c = 3;\n" }]);
    const afterAdd = localWalkFingerprint(root);
    expect(afterAdd?.hash).not.toBe(afterEdit?.hash);
    expect(Object.keys(afterAdd?.entries ?? {})).toContain("src/c.ts");

    // Deleted file → different fingerprint, gone from entries
    fs.rmSync(path.join(root, "src", "c.ts"));
    const afterDelete = localWalkFingerprint(root);
    expect(afterDelete?.hash).not.toBe(afterAdd?.hash);
    expect(Object.keys(afterDelete?.entries ?? {})).not.toContain("src/c.ts");
  });

  it("skips node_modules and .citycode-cache like the parser's walker", () => {
    const root = makeTempDir();
    dirs.push(root);
    writeFiles(root, [{ path: "src/a.ts", contents: "export const a = 1;\n" }]);
    const base = localWalkFingerprint(root);
    writeFiles(root, [
      { path: "node_modules/pkg/x.ts", contents: "export const x = 1;\n" },
      { path: ".citycode-cache/stray.ts", contents: "export const y = 2;\n" },
    ]);
    const afterNoise = localWalkFingerprint(root);
    expect(afterNoise?.hash).toBe(base?.hash);
  });
});

/* ------------------------------------------------------------------ *
 * save.ts / load.ts — atomic persistence + corruption handling
 * ------------------------------------------------------------------ */

describe("saveSnapshot / loadSnapshot", () => {
  it("roundtrips a snapshot byte-for-byte and overwrites in place", () => {
    const snapshot = minimalSnapshot({
      llmSummaries: { "src/a.ts": { text: "explains things", size: 42, mtimeMs: 1234.5 } },
    });
    const repoKey = "local:E:/repos/demo-roundtrip";
    const headSha = "abc123";
    const file = snapshotFilePath(repoKey, headSha);
    snapshotFiles.push(file);

    saveSnapshot(snapshot, repoKey, headSha);
    expect(fs.existsSync(file)).toBe(true);
    expect(loadSnapshot(repoKey, headSha)).toEqual(snapshot);

    // Overwrite must replace, not append or duplicate.
    saveSnapshot({ ...snapshot, stateFingerprint: "new-state" }, repoKey, headSha);
    expect(loadSnapshot(repoKey, headSha)?.stateFingerprint).toBe("new-state");

    // Atomic write: no temp leftovers.
    const siblings = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
    expect(siblings).toEqual([]);
  });

  it("treats missing, truncated, garbage, and wrong-version files as cache misses", () => {
    const repoKey = "local:E:/repos/demo-corrupt";
    const headSha = "def456";
    const file = snapshotFilePath(repoKey, headSha);
    snapshotFiles.push(file);

    expect(loadSnapshot(repoKey, headSha)).toBeUndefined();

    for (const garbage of ["", '{"version":1,"trunca', "}{ not json", "null"]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, garbage, "utf8");
      expect(loadSnapshot(repoKey, headSha)).toBeUndefined();
    }

    fs.writeFileSync(file, JSON.stringify({ ...minimalSnapshot(), version: 42 }), "utf8");
    expect(loadSnapshot(repoKey, headSha)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * save.ts — summary carry-over
 * ------------------------------------------------------------------ */

describe("carryOverSummaries", () => {
  const entries = {
    kept: { text: "kept summary", size: 10, mtimeMs: 100 },
    edited: { text: "stale summary", size: 10, mtimeMs: 100 },
    removed: { text: "orphan summary", size: 5, mtimeMs: 100 },
  };
  const currentStats = {
    kept: { size: 10, mtimeMs: 100 }, // unchanged — carries over
    edited: { size: 12, mtimeMs: 100 }, // size changed — dropped
  };

  it("keeps explanations only for files with matching stats", () => {
    const carried = carryOverSummaries(entries, currentStats);
    expect(Object.keys(carried)).toEqual(["kept"]);
    expect(carried.kept?.text).toBe("kept summary");
  });

  it("handles empty inputs", () => {
    expect(carryOverSummaries({}, currentStats)).toEqual({});
    expect(carryOverSummaries(entries, {})).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * clone.ts — ls-remote parsing
 * ------------------------------------------------------------------ */

describe("parseLsRemoteHead", () => {
  const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"; // 40 hex chars
  it("parses standard output and rejects garbage", () => {
    expect(parseLsRemoteHead(`${sha}\tHEAD\n`)).toBe(sha);
    expect(parseLsRemoteHead("refs/heads/main\nabc\tHEAD\n")).toBeUndefined(); // short sha
    expect(parseLsRemoteHead("")).toBeUndefined();
    expect(parseLsRemoteHead(`no-sha\tHEAD\n`)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * /api/analyze × snapshots — route-level integration
 * ------------------------------------------------------------------ */

const FIXTURE_FILES = [
  { path: "src/a.ts", contents: 'import { b } from "./b";\nexport function alpha() { return b(); }\n' },
  { path: "src/b.ts", contents: "export function beta() { return 1; }\n" },
];

/** Analyze a local folder through the real route handler. */
async function analyzeLocal(dir: string, mode?: "static" | "prev" | "workdir"): Promise<{
  status: number;
  body: Record<string, unknown>;
  raw: Record<string, unknown>;
}> {
  const request = new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode === undefined ? { source: "local", path: dir } : { source: "local", path: dir, mode }),
  });
  const response = await POST(request);
  const raw = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: raw, raw };
}

function repoKeyFor(dir: string): string {
  return computeRepoKey({ source: "local", repoPath: path.resolve(dir).split(path.sep).join("/") });
}

describe("POST /api/analyze — snapshot tier", () => {
  it("serves the same repo from the snapshot with zero layout change (acceptance 1)", async () => {
    const dir = makeTempDir("citycode-snap-");
    dirs.push(dir);
    writeFiles(dir, FIXTURE_FILES);
    const sha = await initRepo(dir);
    const repoKey = repoKeyFor(dir);

    // Cold run: not from cache, snapshot created.
    const cold = await analyzeLocal(dir);
    expect(cold.status).toBe(200);
    expect(cold.body.fromCache).toBeUndefined();
    const snapshotFile = snapshotFilePath(repoKey, sha);
    snapshotFiles.push(snapshotFile);
    expect(fs.existsSync(snapshotFile)).toBe(true);

    // Reload: served from snapshot — identical graph + layout JSON.
    const warm = await analyzeLocal(dir);
    expect(warm.status).toBe(200);
    expect(warm.body.fromCache).toBe(true);
    expect(JSON.stringify(warm.body.graph)).toBe(JSON.stringify(cold.body.graph));
    expect(JSON.stringify(warm.body.layout)).toBe(JSON.stringify(cold.body.layout));
  }, 60_000);

  it("invalidates on a new commit (acceptance 2)", async () => {
    const dir = makeTempDir("citycode-snap-");
    dirs.push(dir);
    writeFiles(dir, FIXTURE_FILES);
    await initRepo(dir);
    const repoKey = repoKeyFor(dir);
    const git = simpleGit(dir);

    const first = await analyzeLocal(dir);
    const sha1 = (first.body.graph as CodeGraph).headSha;
    snapshotFiles.push(snapshotFilePath(repoKey, sha1));

    // New commit → new state → snapshot miss → fresh graph contains the file.
    writeFiles(dir, [{ path: "src/c.ts", contents: "export const c = 3;\n" }]);
    await git.add("-A");
    await git.raw([
      "-c",
      "user.name=CityCode Test",
      "-c",
      "user.email=citycode@test.local",
      "commit",
      "-m",
      "second commit",
    ]);
    const sha2 = (await git.revparse("HEAD")).trim();
    snapshotFiles.push(snapshotFilePath(repoKey, sha2));

    const second = await analyzeLocal(dir);
    expect(second.status).toBe(200);
    expect(second.body.fromCache).toBeUndefined();
    const graph = second.body.graph as CodeGraph;
    expect(graph.headSha).toBe(sha2);
    expect(graph.files.some((file) => file.id === "src/c.ts")).toBe(true);
  }, 60_000);

  it("detects a corrupt snapshot and silently regenerates (acceptance 4)", async () => {
    const dir = makeTempDir("citycode-snap-");
    dirs.push(dir);
    writeFiles(dir, FIXTURE_FILES);
    const sha = await initRepo(dir);
    const repoKey = repoKeyFor(dir);
    const snapshotFile = snapshotFilePath(repoKey, sha);
    snapshotFiles.push(snapshotFile);

    const cold = await analyzeLocal(dir);
    expect(fs.existsSync(snapshotFile)).toBe(true);

    // Simulate a truncated write.
    fs.writeFileSync(snapshotFile, '{"version":1,"graph":', "utf8");
    expect(loadSnapshot(repoKey, sha)).toBeUndefined();

    const regenerated = await analyzeLocal(dir);
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.fromCache).toBeUndefined(); // not served from the broken file
    expect(loadSnapshot(repoKey, sha)).toBeDefined(); // valid file written again
    expect(JSON.stringify(regenerated.body.graph)).toBe(JSON.stringify(cold.body.graph));
  }, 60_000);

  it("answers a cold compare from the snapshot (frozen graph + live diff)", async () => {
    const dir = makeTempDir("citycode-snap-");
    dirs.push(dir);
    writeFiles(dir, FIXTURE_FILES);
    const sha = await initRepo(dir);
    const repoKey = repoKeyFor(dir);
    snapshotFiles.push(snapshotFilePath(repoKey, sha));

    const first = await analyzeLocal(dir); // warm the snapshot file
    expect(first.status).toBe(200);

    // Server "restart": drop all in-memory state, then compare directly.
    resetStoresForTests();
    const compare = await analyzeLocal(dir, "workdir");

    expect(compare.status).toBe(200);
    expect(compare.body.fromCache).toBe(true);
    expect(JSON.stringify(compare.body.graph)).toBe(JSON.stringify(first.body.graph));
    expect(compare.body.changeSet).toBeDefined();
    const changeSet = compare.body.changeSet as { counts: Record<string, number> };
    expect(Object.values(changeSet.counts).every((count) => count === 0)).toBe(true); // clean workdir
  }, 60_000);
});
