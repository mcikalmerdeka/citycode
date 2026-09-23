import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { buildGraph } from "../lib/parser/buildGraph";
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
