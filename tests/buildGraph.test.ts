import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { buildGraph, isSkimResult } from "../lib/parser/buildGraph";
import { cleanup, makeTempDir, writeFiles } from "./helpers/fixtures";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

/** Mirror of the repoPath normalization rule: absolute, forward slashes. */
function toPosix(absolutePath: string): string {
  return absolutePath.split(path.sep).join("/");
}

describe("buildGraph — single file (slice a)", () => {
  it("returns exactly one node with correct loc, language and 1-based function spans", async () => {
    const root = makeTempDir("citycode-bg-one-");
    dirs.push(root);
    writeFiles(root, [
      {
        path: "hello.ts",
        contents: [
          "export class Greeter {", // line 1
          "  greet(): string {", // line 2
          '    return "hello";', // line 3
          "  }", // line 4
          "}", // line 5
          "", // line 6
          "export function main(): void {", // line 7
          "  const g = new Greeter();", // line 8
          "  g.greet();", // line 9
          "}", // line 10
          "", // line 11
          "async function* gen(): AsyncGenerator<number> {", // line 12
          "  yield 1;", // line 13
          "}", // line 14
          "",
        ].join("\n"),
      },
    ]);

    const { graph, warnings } = await buildGraph(root);

    expect(warnings).toEqual([]);
    expect(graph.files).toHaveLength(1);

    const node = graph.files[0];
    expect(node).toEqual({
      id: "hello.ts",
      path: "hello.ts",
      loc: 14,
      language: "typescript",
      functions: [
        { name: "greet", startLine: 2, endLine: 4 },
        { name: "main", startLine: 7, endLine: 10 },
        { name: "gen", startLine: 12, endLine: 14 },
      ],
      externalImports: [],
      unresolvedImports: [],
    });

    expect(graph.edges).toEqual([]);
    expect(graph.headSha).toBeUndefined();
    expect(graph.repoPath).toBe(toPosix(path.resolve(root)));
    expect(graph.source).toBe("local");
  });
});

describe("buildGraph — two files, one relative import (slice b)", () => {
  it("creates exactly one edge: fromId = importer, toId = imported", async () => {
    const root = makeTempDir("citycode-bg-two-");
    dirs.push(root);
    writeFiles(root, [
      {
        path: "app.ts",
        contents: [
          'import { helper } from "./util";',
          "",
          "export function run(): number {",
          "  return helper();",
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "util.ts",
        contents: ["export function helper(): number {", "  return 42;", "}", ""].join("\n"),
      },
    ]);

    const { graph, warnings } = await buildGraph(root);

    expect(warnings).toEqual([]);
    expect(graph.files.map((f) => f.id)).toEqual(["app.ts", "util.ts"]);
    expect(graph.edges).toEqual([{ fromId: "app.ts", toId: "util.ts", symbol: "helper" }]);

    const util = graph.files.find((f) => f.id === "util.ts");
    expect(util?.functions).toEqual([{ name: "helper", startLine: 1, endLine: 3 }]);
    expect(util?.loc).toBe(3); // 3 lines; trailing "" keeps the file newline-terminated
  });
});

describe("buildGraph — input validation", () => {
  it("throws a clear Error for a nonexistent folder (path in the message)", async () => {
    const parent = makeTempDir("citycode-bg-missing-");
    dirs.push(parent);
    const missing = path.join(parent, "does-not-exist");

    await expect(buildGraph(missing)).rejects.toThrow(/does-not-exist/);
  });

  it("throws a clear Error for a folder with no supported source files", async () => {
    const empty = makeTempDir("citycode-bg-empty-");
    dirs.push(empty);

    await expect(buildGraph(empty)).rejects.toThrow(/no supported source files/);
    await expect(buildGraph(empty)).rejects.toThrow(/citycode-bg-empty-/);
  });

  it("explains itself when the folder holds only unparseable code (e.g. plain .js)", async () => {
    const jsRepo = makeTempDir("citycode-bg-jsclone-");
    dirs.push(jsRepo);
    writeFiles(jsRepo, [
      { path: "main.js", contents: "var x = 1;\n" },
      { path: "util.js", contents: "var y = 2;\n" },
      { path: "README.md", contents: "# js repo\n" },
    ]);

    const error = await buildGraph(jsRepo).then(
      () => null,
      (e: Error) => e,
    );
    if (error === null) throw new Error("expected buildGraph to throw");
    expect(error.message).toMatch(/no supported source files/);
    expect(error.message).toMatch(/2 \.js/);
    expect(error.message).toMatch(/TypeScript\/TSX and Python/);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 7 — size guard, skim mode, error-code surfaces
 * ------------------------------------------------------------------ */

describe("buildGraph — skim mode (Phase 7 large-repo guard)", () => {
  it("builds a reduced graph without parsing: loc real, functions and edges empty, repo-level warning", async () => {
    const root = makeTempDir("citycode-bg-skim-");
    dirs.push(root);
    writeFiles(root, [
      { path: "lib/util.ts", contents: "export function helper(): number { return 42; }\n" },
      { path: "app.ts", contents: 'import { helper } from "./lib/util";\nexport function run(): number { return helper(); }\n' },
    ]);

    const { graph, warnings } = await buildGraph(root, "local", { skim: true });

    expect(warnings).toEqual([
      {
        path: "(repo)",
        message:
          "large repository — summarized city: 2 files, per-file functions and import roads omitted; buildings sized by lines of code",
      },
    ]);
    // Every file is a node with real LOC, but zero parse detail — no
    // functions and no edges in either direction.
    expect(graph.files.map((f) => f.id).sort()).toEqual(["app.ts", "lib/util.ts"]);
    for (const file of graph.files) {
      expect(file.functions).toEqual([]);
      expect(file.externalImports).toEqual([]);
      expect(file.unresolvedImports).toEqual([]);
      expect(file.loc).toBeGreaterThan(0);
    }
    expect(graph.edges).toEqual([]);
    expect(isSkimResult(graph)).toBe(true);
  });

  it("skim builds stay byte-identical across runs (determinism contract)", async () => {
    const root = makeTempDir("citycode-bg-skimdet-");
    dirs.push(root);
    writeFiles(root, [
      { path: "b.ts", contents: "export const b = 1;\n" },
      { path: "a.ts", contents: "export const a = 2;\n" },
    ]);

    const first = await buildGraph(root, "local", { skim: true });
    const second = await buildGraph(root, "local", { skim: true });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("a file-count overage without skim throws a readable SkimRequiredError", async () => {
    const root = makeTempDir("citycode-bg-overcut-");
    dirs.push(root);
    for (let i = 0; i < 3; i++) {
      writeFiles(root, [{ path: `f${i}.ts`, contents: `export const v${i} = ${i};\n` }]);
    }

    await expect(buildGraph(root, "local", { maxParseFiles: 2 })).rejects.toThrow(/above the 2 limit/);
    await expect(buildGraph(root, "local", { maxParseFiles: 2 })).rejects.toThrow(/skim mode/);
  });

  it("a total-LOC overage throws the readable cutoff error instead of parsing everything", async () => {
    const root = makeTempDir("citycode-bg-overloc-");
    dirs.push(root);
    writeFiles(root, [
      { path: "big.ts", contents: `export const big = [\n${Array.from({ length: 20 }, () => "  1,").join("\n")}\n];\n` },
      { path: "small.ts", contents: "export const s = 1;\n" },
    ]);

    await expect(buildGraph(root, "local", { maxTotalLoc: 10 })).rejects.toThrow(/lines of code/);
    await expect(buildGraph(root, "local", { maxTotalLoc: 10 })).rejects.toThrow(/skim mode/);
  });

  it("signals the walk and parse milestones through onProgress without touching output", async () => {
    const root = makeTempDir("citycode-bg-prog-");
    dirs.push(root);
    writeFiles(root, [{ path: "a.ts", contents: "export const a = 1;\n" }]);

    const events: Array<{ stage: string; files?: number }> = [];
    const { graph } = await buildGraph(root, "local", {
      onProgress: (event) => {
        if (event.stage === "walked") events.push({ stage: "walked", files: event.files });
        else events.push({ stage: event.stage });
      },
    });

    expect(events).toEqual([
      { stage: "walked", files: 1 },
      { stage: "parsed" },
    ]);
    expect(graph.files).toHaveLength(1);
  });
});

describe("buildGraph — fs error-code surfaces (Phase 7)", () => {
  it("a nonexistent folder maps ENOENT to the 'does not exist' message", async () => {
    const parent = makeTempDir("citycode-bg-enoent-");
    dirs.push(parent);
    const missing = path.join(parent, "vanished");

    await expect(buildGraph(missing)).rejects.toThrow(/input folder does not exist/);
  });

  it("BOM-leading sources parse the same as clean ones (Windows-authored files)", async () => {
    const root = makeTempDir("citycode-bg-bom-");
    dirs.push(root);
    writeFiles(root, [
      { path: "bom.ts", contents: "\uFEFFexport function main(): number { return 1; }\n" },
    ]);

    const { graph, warnings } = await buildGraph(root);
    expect(warnings).toEqual([]);
    const file = graph.files.find((f) => f.id === "bom.ts");
    expect(file?.loc).toBe(1);
    expect(file?.functions).toEqual([{ name: "main", startLine: 1, endLine: 1 }]);
  });

  it("CRLF line endings count like editor line counts", async () => {
    const root = makeTempDir("citycode-bg-crlf-");
    dirs.push(root);
    writeFiles(root, [
      { path: "crlf.ts", contents: "export function a() {\r\n  return 1;\r\n}\r\n" },
    ]);

    const { graph } = await buildGraph(root);
    const file = graph.files.find((f) => f.id === "crlf.ts");
    expect(file?.loc).toBe(3);
    expect(file?.functions).toEqual([{ name: "a", startLine: 1, endLine: 3 }]);
  });
});
