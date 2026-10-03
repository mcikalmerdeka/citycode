import { describe, expect, it } from "vitest";
import {
  getCachedGuide,
  getCachedWorkflow,
  guidanceCacheKey,
  rememberGuide,
  rememberWorkflow,
  resetStoresForTests,
  storeGraph,
} from "../lib/llm/graphCache";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll } from "vitest";
import type { CodeGraph, FileNode } from "../lib/types";
import { selectKeyFiles } from "../lib/llm/keyFiles";
import {
  GUIDE_SYSTEM_PROMPT,
  WORKFLOW_SYSTEM_PROMPT,
  buildGuideUserPrompt,
  buildWorkflowUserPrompt,
  renderNumberedSource,
} from "../lib/llm/guidePrompts";
import type { KeyFileSelection } from "../lib/llm/keyFiles";
import {
  isRepoGuide,
  isWorkflowDetail,
  type RepoGuide,
  type WorkflowDetail,
  type WorkflowSummary,
} from "../lib/guidance/types";
import { isSnapshot, SNAPSHOT_VERSION } from "../lib/snapshot/schema";

const GUIDE: RepoGuide = {
  identity: "A demo repo.",
  workflows: [],
  features: [],
  readingPath: [],
  dataFlow: "",
};

const DETAIL: WorkflowDetail = {
  workflowId: "wf",
  steps: [{ fileId: "a.ts", title: "t", narration: "n", startLine: 1, endLine: 2 }],
};

describe("guidance caches", () => {
  it("guide is repo-state keyed: headSha participates, undefined headSha is its own slot", () => {
    expect(getCachedGuide("local:E:/repos/demo", "abc123")).toBeUndefined();
    rememberGuide("local:E:/repos/demo", "abc123", GUIDE);
    expect(getCachedGuide("local:E:/repos/demo", "abc123")).toBe(GUIDE);
    // new HEAD ⇒ new guide slot
    expect(getCachedGuide("local:E:/repos/demo", "def456")).toBeUndefined();
    // non-git local folder ⇒ its own slot under headSha "none"
    rememberGuide("local:E:/repos/demo", undefined, { ...GUIDE, identity: "no git" });
    expect(guidanceCacheKey("local:E:/repos/demo", undefined)).toBe("local:E:/repos/demo\u0000none");
    expect(getCachedGuide("local:E:/repos/demo", undefined)?.identity).toBe("no git");
  });

  it("workflows are cached per workflow id within a repo state", () => {
    rememberWorkflow("k", "s", DETAIL);
    expect(getCachedWorkflow("k", "s", "wf")).toBe(DETAIL);
    expect(getCachedWorkflow("k", "s", "other")).toBeUndefined();
    expect(getCachedWorkflow("k", "t", "wf")).toBeUndefined();
  });

  it("re-analysis (a different graph object for the same repo) drops cached guidance", () => {
    const first = graph([fileNode("a.ts")], []);
    first.repoPath = "E:/repos/reanalyzed";
    const key = "local:E:/repos/reanalyzed";
    storeGraph(first);
    rememberGuide(key, "abc123", GUIDE);
    rememberWorkflow(key, "abc123", DETAIL);

    storeGraph(first); // same object: nothing changed, nothing dropped
    expect(getCachedGuide(key, "abc123")).toBeDefined();

    storeGraph({ ...first }); // re-analyzed: new object for the same repo
    expect(getCachedGuide(key, "abc123")).toBeUndefined();
    expect(getCachedWorkflow(key, "abc123", "wf")).toBeUndefined();
  });

  it("resetStoresForTests clears them", () => {
    rememberGuide("k", "s", GUIDE);
    rememberWorkflow("k", "s", DETAIL);
    resetStoresForTests();
    expect(getCachedGuide("k", "s")).toBeUndefined();
    expect(getCachedWorkflow("k", "s", "wf")).toBeUndefined();
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
 * Guide prompts (guidePrompts.ts)
 * ------------------------------------------------------------------ */

describe("guide prompts", () => {
  const selection: KeyFileSelection = {
    files: [
      { path: "README.md", contents: "# Demo" },
      { path: "src/one.ts", contents: "one-contents" },
    ],
    droppedByBudget: 0,
  };

  it("asks for ONE JSON object with all five parts and forbids invented files", () => {
    for (const part of ["identity", "workflows", "features", "readingPath", "dataFlow"]) {
      expect(GUIDE_SYSTEM_PROMPT).toContain(`"${part}"`);
    }
    expect(GUIDE_SYSTEM_PROMPT).toContain("ONE JSON object");
    expect(GUIDE_SYSTEM_PROMPT).toContain("FILE INDEX");
    expect(GUIDE_SYSTEM_PROMPT).toContain("Never invent a path");
  });

  it("embeds identity, folders, the file index, import links, and key files", () => {
    const g = graph(
      [fileNode("src/one.ts", 30), fileNode("lib/two.ts", 5)],
      [{ from: "src/one.ts", to: "lib/two.ts" }],
    );
    const prompt = buildGuideUserPrompt(g, selection);
    expect(prompt).toContain("Source: local — E:/repos/demo");
    expect(prompt).toContain("Files: 2 · Total lines of code: 35");
    expect(prompt).toContain("lib (1 files, 5 lines)");
    expect(prompt).toContain("FILE INDEX (2 of 2 files");
    expect(prompt).toContain("src/one.ts (30 loc, entry)");
    expect(prompt).toContain("lib/two.ts (5 loc)");
    expect(prompt).toContain("src/one.ts -> lib/two.ts");
    expect(prompt).toContain("--- README.md");
    expect(prompt).toContain("one-contents");
  });

  it("keeps test files out of the citable index", () => {
    const g = graph(
      [fileNode("src/a.ts"), fileNode("src/b.ts"), fileNode("src/c.ts"), fileNode("tests/a.test.ts")],
      [{ from: "tests/a.test.ts", to: "src/a.ts" }],
    );
    const prompt = buildGuideUserPrompt(g, { files: [], droppedByBudget: 0 });
    expect(prompt).toContain("FILE INDEX (3 of 4 files");
    expect(prompt).not.toContain("tests/a.test.ts (");
  });

  it("keeps tooling dot-directories out of the citable index, unless nothing else exists", () => {
    const g = graph(
      [fileNode("src/a.ts"), fileNode("src/b.ts"), fileNode("src/c.ts"), fileNode(".agents/skills/x/app.py")],
      [],
    );
    const prompt = buildGuideUserPrompt(g, { files: [], droppedByBudget: 0 });
    expect(prompt).toContain("FILE INDEX (3 of 4 files");
    expect(prompt).not.toContain(".agents/skills/x/app.py (");

    // A repo that is ONLY tooling-shaped still gets an index rather than an empty one.
    const only = graph([fileNode(".tools/a.ts"), fileNode(".tools/b.ts")], []);
    expect(buildGuideUserPrompt(only, { files: [], droppedByBudget: 0 })).toContain("FILE INDEX (2 of 2 files");
  });

  it("embeds a skim notice when the graph has no edges and no functions", () => {
    const g = graph([fileNode("src/one.ts")], []);
    const prompt = buildGuideUserPrompt(g, { files: [], droppedByBudget: 0 });
    expect(prompt).toContain("summarized mode");
  });
});

/* ------------------------------------------------------------------ *
 * Workflow prompts (guidePrompts.ts)
 * ------------------------------------------------------------------ */

describe("workflow prompts", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`);

  it("system prompt demands numbered-line citations and bans invented files", () => {
    expect(WORKFLOW_SYSTEM_PROMPT).toContain("startLine");
    expect(WORKFLOW_SYSTEM_PROMPT).toContain("N| code");
    expect(WORKFLOW_SYSTEM_PROMPT).toContain("Never invent files");
  });

  it("renderNumberedSource shows a small file whole, with right-aligned line numbers", () => {
    const out = renderNumberedSource(["a", "b", "c"], [], 1000);
    expect(out).toBe("1| a\n2| b\n3| c");
  });

  it("windows a big file around the focus range, keeping original numbers and marking gaps", () => {
    const out = renderNumberedSource(lines, [{ startLine: 200, endLine: 205 }], 2_500);
    expect(out).toContain("  1| const line1 = 1;"); // head window
    expect(out).toContain("200| const line200 = 200;"); // focus
    expect(out).toContain("(lines 41–196 omitted)"); // gap between the 40-line head and the focus window (197–208)
    expect(out).not.toContain("const line100 = 100;"); // the gap really is skipped
  });

  it("with no focus, shows the file from the top until the budget runs out", () => {
    const out = renderNumberedSource(lines, [], 400);
    expect(out).toContain("  1| const line1 = 1;");
    expect(out).toContain("truncated after line");
    expect(out).not.toContain("const line300");
  });

  it("buildWorkflowUserPrompt lists the route, import links, and the numbered source", () => {
    const fn = { name: "handle", startLine: 2, endLine: 3 };
    const route = { ...fileNode("app/route.ts", 4), functions: [fn] };
    const lib = fileNode("lib/work.ts", 3);
    const g: CodeGraph = {
      files: [route, lib],
      edges: [{ fromId: "app/route.ts", toId: "lib/work.ts", symbol: "doWork" }],
      headSha: "abc123",
      repoPath: "E:/repos/demo",
      source: "local",
    };
    const workflow: WorkflowSummary = {
      id: "run-it",
      title: "Run it",
      goal: "Do the work",
      trigger: "A request arrives",
      route: [{ fileId: "app/route.ts", symbol: "handle" }, { fileId: "lib/work.ts" }],
    };
    const sources = new Map<string, string[]>([
      ["app/route.ts", ["import x", "export function handle() {", "}", ""]],
      ["lib/work.ts", ["a", "b", "c"]],
    ]);
    const prompt = buildWorkflowUserPrompt(g, workflow, sources);
    expect(prompt).toContain("WORKFLOW: Run it");
    expect(prompt).toContain("1. app/route.ts :: handle");
    expect(prompt).toContain("2. lib/work.ts");
    expect(prompt).toContain("app/route.ts -> lib/work.ts{doWork}");
    expect(prompt).toContain("=== app/route.ts (typescript, 4 lines) — functions: handle (lines 2-3)");
    expect(prompt).toContain("2| export function handle() {");
  });

  it("tells the model when a route file's source is unavailable", () => {
    const g = graph([fileNode("a.ts"), fileNode("b.ts")], []);
    const workflow: WorkflowSummary = {
      id: "w",
      title: "W",
      goal: "g",
      trigger: "t",
      route: [{ fileId: "a.ts" }, { fileId: "b.ts" }],
    };
    expect(buildWorkflowUserPrompt(g, workflow, new Map())).toContain("source unavailable");
  });
});

/* ------------------------------------------------------------------ *
 * Snapshot guide fields (schema.ts) + shape guards (types.ts)
 * ------------------------------------------------------------------ */

describe("snapshot guide fields", () => {
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

  it("accepts old snapshots without guide fields (backward compat)", () => {
    expect(isSnapshot(baseSnapshot())).toBe(true);
  });

  it("still loads snapshots carrying the legacy plain-text repoGuidance field", () => {
    expect(isSnapshot(baseSnapshot({ repoGuidance: "old guide text" }))).toBe(true);
  });

  it("accepts snapshots carrying a structured guide and traced workflows", () => {
    expect(isSnapshot(baseSnapshot({ repoGuide: GUIDE, workflowDetails: { wf: DETAIL } }))).toBe(true);
  });

  it("isRepoGuide / isWorkflowDetail accept real shapes and reject malformed ones", () => {
    expect(isRepoGuide(GUIDE)).toBe(true);
    expect(isRepoGuide("a plain string")).toBe(false);
    expect(isRepoGuide({ ...GUIDE, workflows: [{ id: "x" }] })).toBe(false);
    expect(isWorkflowDetail(DETAIL)).toBe(true);
    expect(isWorkflowDetail({ workflowId: "wf", steps: [] })).toBe(false);
    expect(isWorkflowDetail({ ...DETAIL, steps: [{ ...DETAIL.steps[0], startLine: "1" }] })).toBe(false);
    expect(
      isWorkflowDetail({ ...DETAIL, steps: [{ ...DETAIL.steps[0], excerpt: { startLine: 1, lines: [1] } }] }),
    ).toBe(false);
  });
});
