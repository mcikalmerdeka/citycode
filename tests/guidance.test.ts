import { describe, expect, it } from "vitest";
import {
  getCachedGuidance,
  guidanceCacheKey,
  rememberGuidance,
  resetStoresForTests,
} from "../lib/llm/graphCache";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll } from "vitest";
import type { CodeGraph, FileNode } from "../lib/types";
import { selectKeyFiles } from "../lib/llm/keyFiles";
import {
  buildRepoGuidanceUserPrompt,
  REPO_GUIDANCE_SYSTEM_PROMPT,
} from "../lib/llm/prompts";
import type { KeyFileSelection } from "../lib/llm/keyFiles";
import { isSnapshot, SNAPSHOT_VERSION } from "../lib/snapshot/schema";

describe("guidance cache", () => {
  it("is repo-state keyed: headSha participates, undefined headSha is its own slot", () => {
    expect(getCachedGuidance("local:E:/repos/demo", "abc123")).toBeUndefined();
    rememberGuidance("local:E:/repos/demo", "abc123", "the guide");
    expect(getCachedGuidance("local:E:/repos/demo", "abc123")).toBe("the guide");
    // new HEAD ⇒ new guide slot
    expect(getCachedGuidance("local:E:/repos/demo", "def456")).toBeUndefined();
    // non-git local folder ⇒ its own slot under headSha "none"
    rememberGuidance("local:E:/repos/demo", undefined, "nogit guide");
    expect(guidanceCacheKey("local:E:/repos/demo", undefined)).toBe(
      "local:E:/repos/demo\u0000none",
    );
    expect(getCachedGuidance("local:E:/repos/demo", undefined)).toBe("nogit guide");
  });

  it("resetStoresForTests clears it", () => {
    rememberGuidance("k", "s", "g");
    resetStoresForTests();
    expect(getCachedGuidance("k", "s")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Key-file selection (keyFiles.ts)
 * ------------------------------------------------------------------ */

function fileNode(id: string, loc = 10): FileNode {
  return {
    id,
    path: id,
    loc,
    language: "typescript",
    functions: [],
    externalImports: [],
    unresolvedImports: [],
  };
}

function graph(files: FileNode[], edges: Array<{ from: string; to: string }>): CodeGraph {
  return {
    files,
    edges: edges.map((edge) => ({ fromId: edge.from, toId: edge.to })),
    headSha: "abc123",
    repoPath: "E:/repos/demo",
    source: "local",
  };
}

describe("selectKeyFiles", () => {
  let dir: string;

  // Deterministic fs seeding for one temp repo root; graph.repoPath (POSIX
  // form) is where selectKeyFiles reads from.
  async function seed(root: string, relPath: string, contents: string): Promise<void> {
    const abs = path.join(root, ...relPath.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "citycode-guidance-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function posixed(): string {
    return dir.replaceAll("\\", "/");
  }

  it("prefers README first, then shallow entry points, then highest fan-in", async () => {
    await seed(dir, "README.md", "# Demo\nreadme contents");
    await seed(dir, "src/main.ts", "content-main");
    await seed(dir, "lib/util.ts", "content-util");
    const g = graph(
      [fileNode("README.md"), fileNode("src/main.ts"), fileNode("lib/util.ts")],
      [{ from: "src/main.ts", to: "lib/util.ts" }, { from: "README.md", to: "lib/util.ts" }],
    );
    g.repoPath = posixed();
    const selection = await selectKeyFiles(g);
    // README is category 0; entry (fan-in 0) beats "other" category even at
    // fan-in 2; util.ts is category 2 with the highest fan-in.
    expect(selection.files.map((f) => f.path)).toEqual(
      ["README.md", "src/main.ts", "lib/util.ts"],
    );
    expect(selection.files[0]!.contents).toContain("readme contents");
  });

  it("caps at 12 files; drops beyond the count budget; truncates one huge file", async () => {
    for (let i = 0; i < 15; i++) {
      await seed(dir, `pkg/f${i}.ts`, "x");
    }
    const g = graph(
      Array.from({ length: 15 }, (_, i) => fileNode(`pkg/f${i}.ts`)),
      [],
    );
    g.repoPath = posixed();
    const selection = await selectKeyFiles(g);
    expect(selection.files.length).toBe(12);
    expect(selection.droppedByBudget).toBe(3);

    await seed(dir, "big/huge.ts", "y".repeat(50_000));
    const g2 = graph([fileNode("big/huge.ts")], []);
    g2.repoPath = posixed();
    const sel2 = await selectKeyFiles(g2);
    expect(sel2.files.length).toBe(1);
    expect(sel2.files[0]!.contents).toContain("[truncated]");
    expect(sel2.files[0]!.contents.length).toBeGreaterThanOrEqual(40_000);
    expect(sel2.droppedByBudget).toBe(0);
  });

  it("is fail-soft: unreadable and non-text files are skipped, never thrown", async () => {
    const g = graph(
      [
        fileNode("plans/binary.bin"),
        fileNode("missing/never-existed.ts"),
        fileNode("src/real.ts"),
      ],
      [],
    );
    g.repoPath = posixed();
    await seed(dir, "src/real.ts", "real-contents");
    const selection = await selectKeyFiles(g);
    expect(selection.files.map((f) => f.path)).toEqual(["src/real.ts"]);
  });

  it("uses graph.repoPath as the read root (no extra sourcePath parameter)", async () => {
    await seed(dir, "src/one.ts", "one-contents");
    const g = graph([fileNode("src/one.ts")], []);
    g.repoPath = posixed();
    const selection = await selectKeyFiles(g);
    expect(selection.files).toEqual([{ path: "src/one.ts", contents: "one-contents" }]);
  });

  it("stops reading candidates once the char budget is exhausted", async () => {
    await seed(dir, "z/huge.ts", "z".repeat(40_001));
    for (let i = 0; i < 3; i++) await seed(dir, `z/after${i}.ts`, `after${i}`);
    const g = graph(
      [fileNode("z/huge.ts", 40_001), fileNode("z/after0.ts"), fileNode("z/after1.ts"), fileNode("z/after2.ts")],
      [],
    );
    g.repoPath = posixed();
    const selection = await selectKeyFiles(g);
    // huge.ts consumes the 40k budget to the char (truncated by 1 char);
    // the remaining candidates are dropped whole — never pushed as
    // marker-only stubs.
    expect(selection.files.length).toBe(1);
    expect(selection.files[0]!.contents).toContain("[truncated]");
    expect(selection.droppedByBudget).toBe(3);
  });

  it("empty graph yields an empty selection", async () => {
    const selection = await selectKeyFiles(graph([], []));
    expect(selection.files).toEqual([]);
    expect(selection.droppedByBudget).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Repo guidance prompts (prompts.ts)
 * ------------------------------------------------------------------ */

describe("repo guidance prompts", () => {
  const selection: KeyFileSelection = {
    files: [
      { path: "README.md", contents: "# Demo" },
      { path: "src/one.ts", contents: "one-contents" },
    ],
    droppedByBudget: 0,
  };

  it("requires the four numbered sections in plain English", () => {
    expect(REPO_GUIDANCE_SYSTEM_PROMPT).toContain("plain English");
    expect(REPO_GUIDANCE_SYSTEM_PROMPT).toContain("1.");
    expect(REPO_GUIDANCE_SYSTEM_PROMPT).toContain("2.");
    expect(REPO_GUIDANCE_SYSTEM_PROMPT).toContain("3.");
    expect(REPO_GUIDANCE_SYSTEM_PROMPT).toContain("4.");
    expect(REPO_GUIDANCE_SYSTEM_PROMPT.toLowerCase()).toContain("data flow");
  });

  it("embeds repo identity, top-level tree, fan-in leaders, and key files", () => {
    const g = graph(
      [fileNode("src/one.ts", 30), fileNode("lib/two.ts", 5)],
      [{ from: "src/one.ts", to: "lib/two.ts" }],
    );
    const prompt = buildRepoGuidanceUserPrompt(g, selection);
    expect(prompt).toContain("Source: local — E:/repos/demo");
    expect(prompt).toContain("Files: 2 · Total lines of code: 35");
    expect(prompt).toContain("lib (1 files, 5 lines)");
    expect(prompt).toContain("Most imported (fan-in leaders): lib/two.ts");
    expect(prompt).toContain("--- README.md");
    expect(prompt).toContain("# Demo");
    expect(prompt).toContain("--- src/one.ts");
    expect(prompt).toContain("one-contents");
  });

  it("embeds a skim notice when the graph has no edges and no functions", () => {
    const g = graph([fileNode("src/one.ts")], []);
    const prompt = buildRepoGuidanceUserPrompt(g, { files: [], droppedByBudget: 0 });
    expect(prompt).toContain("summarized mode");
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot repoGuidance field (schema.ts)
 * ------------------------------------------------------------------ */

describe("snapshot repoGuidance field", () => {
  function baseSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: SNAPSHOT_VERSION,
      source: "github",
      repoPathOrUrl: "https://github.com/owner/repo",
      stateFingerprint: "fp",
      fileStats: {},
      graph: { files: [], edges: [] },
      layout: { buildings: [], districts: [], roads: [] },
      warnings: [],
      llmSummaries: {},
      compareSummaries: {},
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("accepts old snapshots without repoGuidance (backward compat)", () => {
    expect(isSnapshot(baseSnapshot())).toBe(true);
  });

  it("accepts a string repoGuidance", () => {
    expect(isSnapshot(baseSnapshot({ repoGuidance: "the guide" }))).toBe(true);
  });

  it("rejects a non-string repoGuidance", () => {
    expect(isSnapshot(baseSnapshot({ repoGuidance: 42 }))).toBe(false);
  });
});
