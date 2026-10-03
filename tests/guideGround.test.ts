import { describe, expect, it } from "vitest";
import {
  GUIDE_LIMITS,
  buildExcerpt,
  extractJsonObject,
  groundGuide,
  groundWorkflowDetail,
  normalizePath,
  resolveRange,
  slugify,
  splitLines,
} from "../lib/guidance/ground";
import type { CodeGraph, FileNode, SymbolDef } from "../lib/types";

function node(id: string, loc: number, functions: SymbolDef[] = []): FileNode {
  return { id, path: id, loc, language: "typescript", functions, externalImports: [], unresolvedImports: [] };
}

const graph: CodeGraph = {
  files: [
    node("app/route.ts", 40, [{ name: "handle", startLine: 10, endLine: 30 }]),
    node("lib/work.ts", 100, [{ name: "doWork", startLine: 5, endLine: 90 }]),
    node("lib/util.ts", 10),
  ],
  edges: [],
  repoPath: "E:/x",
  source: "local",
};

const numbered = (count: number): string[] => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe("small helpers", () => {
  it("extractJsonObject tolerates code fences and chatter, and fails readably otherwise", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! Here you go: {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject("no json here")).toThrow(/did not return a JSON object/);
    expect(() => extractJsonObject("{broken: json}")).toThrow(/could not be parsed/);
  });

  it("normalizePath and slugify", () => {
    expect(normalizePath("./lib\\work.ts")).toBe("lib/work.ts");
    expect(normalizePath("/lib/work.ts")).toBe("lib/work.ts");
    expect(normalizePath(42)).toBe("");
    expect(slugify("Import a GitHub repo!")).toBe("import-a-github-repo");
    expect(slugify("???")).toBe("workflow");
  });

  it("splitLines matches the graph's LOC convention (no phantom trailing line)", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("groundGuide", () => {
  const rawGuide = {
    identity: "  A demo   repo\nthat does things. ",
    workflows: [
      {
        title: "Run it",
        goal: "Do the thing",
        trigger: "A request arrives",
        route: [
          { file: "app/route.ts", symbol: "HANDLE()" },
          { file: "./lib/work.ts", symbol: "doesNotExist" },
          { file: "invented/ghost.ts" },
          { file: "lib/work.ts", symbol: "doWork" },
        ],
      },
      { title: "Run it", goal: "Same title, different flow", route: [{ file: "app/route.ts" }, { file: "lib/util.ts" }] },
      { title: "One file only", goal: "Nothing to animate", route: [{ file: "lib/util.ts" }, { file: "lib/util.ts" }] },
      { title: "", goal: "No title", route: [{ file: "app/route.ts" }, { file: "lib/util.ts" }] },
    ],
    features: [
      { title: "Core", summary: "Does work", files: ["lib/work.ts", "lib/work.ts", "nope.ts", "app/route.ts"] },
      { title: "No summary", summary: "", files: [] },
    ],
    readingPath: [
      { file: "app/route.ts", why: "Start here" },
      { file: "app/route.ts", why: "duplicate" },
      { file: "ghost.ts", why: "invented" },
      { file: "lib/util.ts", why: "" },
    ],
    dataFlow: "Input becomes output.",
  };

  it("keeps real references, drops invented ones, and cleans text", () => {
    const guide = groundGuide(rawGuide, graph);
    expect(guide.identity).toBe("A demo repo that does things.");
    expect(guide.features).toEqual([
      { title: "Core", summary: "Does work", files: ["lib/work.ts", "app/route.ts"] },
    ]);
    expect(guide.readingPath).toEqual([{ fileId: "app/route.ts", why: "Start here" }]);
    expect(guide.dataFlow).toBe("Input becomes output.");
  });

  it("snaps route symbols to real functions, drops unknown files/symbols, and keeps route order", () => {
    const [first] = groundGuide(rawGuide, graph).workflows;
    expect(first!.route).toEqual([
      { fileId: "app/route.ts", symbol: "handle" },
      { fileId: "lib/work.ts" },
      { fileId: "lib/work.ts", symbol: "doWork" },
    ]);
  });

  it("gives colliding titles distinct ids and drops single-file or untitled workflows", () => {
    const workflows = groundGuide(rawGuide, graph).workflows;
    expect(workflows.map((w) => w.id)).toEqual(["run-it", "run-it-2"]);
  });

  it("caps the number of workflows", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `Flow ${i}`,
      goal: "g",
      route: [{ file: "app/route.ts" }, { file: "lib/util.ts" }],
    }));
    expect(groundGuide({ ...rawGuide, workflows: many }, graph).workflows).toHaveLength(GUIDE_LIMITS.workflows);
  });

  it("throws a readable error when nothing usable remains", () => {
    expect(() => groundGuide({ identity: "", workflows: [], features: [] }, graph)).toThrow(/unusable repository guide/);
    expect(() => groundGuide({ identity: "x", workflows: [], features: [] }, graph)).toThrow(/unusable repository guide/);
    expect(() => groundGuide("not an object", graph)).toThrow(/unusable repository guide/);
  });
});

describe("resolveRange", () => {
  const handle: SymbolDef = { name: "handle", startLine: 10, endLine: 30 };

  it("keeps the model's lines when they sit inside the named function", () => {
    expect(resolveRange(40, handle, 12, 18)).toEqual({ startLine: 12, endLine: 18 });
  });

  it("falls back to the function's real span when the model's lines miss it", () => {
    expect(resolveRange(40, handle, 35, 38)).toEqual({ startLine: 10, endLine: 30 });
  });

  it("uses the function span when the model gave no lines, capped to a readable length", () => {
    const huge: SymbolDef = { name: "big", startLine: 5, endLine: 90 };
    expect(resolveRange(100, huge, undefined, undefined)).toEqual({
      startLine: 5,
      endLine: 5 + GUIDE_LIMITS.highlightLines - 1,
    });
  });

  it("trusts the model's lines when no function was named, clamped to the file", () => {
    expect(resolveRange(40, undefined, 30, 999)).toEqual({ startLine: 30, endLine: 40 });
  });

  it("repairs swapped bounds and numeric strings", () => {
    expect(resolveRange(40, undefined, "8", 3)).toEqual({ startLine: 3, endLine: 8 });
  });

  it("shows the top of the file when there is neither a symbol nor valid lines", () => {
    expect(resolveRange(100, undefined, 500, 600)).toEqual({ startLine: 1, endLine: GUIDE_LIMITS.headLines });
    expect(resolveRange(5, undefined, "x", null)).toEqual({ startLine: 1, endLine: 5 });
  });
});

describe("buildExcerpt", () => {
  it("adds context around the range and keeps real line numbers", () => {
    const excerpt = buildExcerpt(numbered(50), { startLine: 20, endLine: 22 });
    expect(excerpt.startLine).toBe(16);
    expect(excerpt.lines[0]).toBe("line 16");
    expect(excerpt.lines.at(-1)).toBe("line 26");
  });

  it("clamps to the file edges and truncates very long lines", () => {
    const edge = buildExcerpt(["only line"], { startLine: 1, endLine: 1 });
    expect(edge).toEqual({ startLine: 1, lines: ["only line"] });
    const long = buildExcerpt(["\tx" + "y".repeat(400)], { startLine: 1, endLine: 1 });
    expect(long.lines[0]!.length).toBeLessThanOrEqual(GUIDE_LIMITS.lineChars);
    expect(long.lines[0]!.endsWith("…")).toBe(true);
    expect(long.lines[0]!.startsWith("  x")).toBe(true); // tab → two spaces
  });
});

describe("groundWorkflowDetail", () => {
  const sources = new Map<string, string[]>([
    ["app/route.ts", numbered(40)],
    ["lib/work.ts", numbered(100)],
  ]);

  const raw = {
    steps: [
      { file: "app/route.ts", symbol: "handle", startLine: 12, endLine: 15, title: "Receive the request", narration: "The route accepts it.", payload: "request body" },
      { file: "ghost.ts", title: "Invented", narration: "Never happens." },
      { file: "lib/work.ts", symbol: "doWork", startLine: 500, endLine: 600, title: "", narration: "Work gets done.", payload: "leftover" },
    ],
  };

  it("grounds each step: verified file, snapped lines, excerpt, cleaned text; drops invented steps", () => {
    const detail = groundWorkflowDetail(raw, graph, "run-it", sources);
    expect(detail.workflowId).toBe("run-it");
    expect(detail.steps).toHaveLength(2);

    const [first, second] = detail.steps;
    expect(first).toMatchObject({
      fileId: "app/route.ts",
      symbol: "handle",
      startLine: 12,
      endLine: 15,
      title: "Receive the request",
      payload: "request body",
    });
    expect(first!.excerpt!.startLine).toBe(8); // 12 − 4 lines of context
    expect(first!.excerpt!.lines[0]).toBe("line 8");

    // Bad cited lines → the function's real span; empty title → derived from the symbol.
    expect(second).toMatchObject({ fileId: "lib/work.ts", symbol: "doWork", startLine: 5, title: "Run doWork" });
  });

  it("the last step hands nothing on", () => {
    const detail = groundWorkflowDetail(raw, graph, "run-it", sources);
    expect(detail.steps.at(-1)!.payload).toBeUndefined();
  });

  it("still works without readable sources (no excerpt), clamping to the graph's LOC", () => {
    const detail = groundWorkflowDetail(
      { steps: [
        { file: "lib/util.ts", startLine: 3, endLine: 99, narration: "First." },
        { file: "lib/util.ts", startLine: 1, endLine: 2, narration: "Second." },
      ] },
      graph,
      "w",
      new Map(),
    );
    expect(detail.steps[0]).toMatchObject({ startLine: 3, endLine: 10 });
    expect(detail.steps[0]!.excerpt).toBeUndefined();
  });

  it("throws a readable error when fewer than two real steps survive", () => {
    const one = { steps: [{ file: "lib/util.ts", narration: "Alone." }, { file: "ghost.ts", narration: "Fake." }] };
    expect(() => groundWorkflowDetail(one, graph, "w", sources)).toThrow(/unusable workflow trace/);
    expect(() => groundWorkflowDetail({ steps: "nope" }, graph, "w", sources)).toThrow(/unusable workflow trace/);
  });

  it("caps the number of steps", () => {
    const many = { steps: Array.from({ length: 30 }, () => ({ file: "lib/util.ts", narration: "Step." })) };
    expect(groundWorkflowDetail(many, graph, "w", new Map()).steps).toHaveLength(GUIDE_LIMITS.steps);
  });
});
