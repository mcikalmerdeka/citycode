import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";

import { buildGraph } from "../lib/parser/buildGraph";
import { cleanup, makeTempDir, writeFiles } from "./helpers/fixtures";

/**
 * Phase 7 — cross-platform sweep (plan task: "Windows paths (spaces,
 * backslashes), long paths, case sensitivity").
 *
 * The dev machine is Windows with a SPACE in the project path, and every
 * fixture directory is a temp dir under os.tmpdir() (programmatic per
 * tech-stack §8). All spawned fixture paths exercise the walker/resolver
 * through the real fs — no mocked paths.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

describe("cross-platform folder handling", () => {
  it("a folder whose absolute path contains spaces parses fine (Windows dev-path shape)", async () => {
    const root = makeTempDir("citycode spaces in name-");
    dirs.push(root);
    writeFiles(root, [{ path: "src/a.ts", contents: "export const a = 1;\n" }]);

    const { graph } = await buildGraph(root);

    expect(graph.repoPath.split(path.sep).join("/")).toBe(
      path.resolve(root).split(path.sep).join("/"),
    );
    expect(graph.files.map((file) => file.id)).toEqual(["src/a.ts"]);
  });

  it("deeply nested folders (6 levels) resolve cleanly with forward-slashed ids", async () => {
    const root = makeTempDir("citycode-deep-");
    dirs.push(root);
    writeFiles(root, [
      { path: "l1/l2/l3/l4/l5/l6/deep.ts", contents: "export function deep() { return 6; }\n" },
      { path: "shallow.ts", contents: 'import { deep } from "./l1/l2/l3/l4/l5/l6/deep";\nexport const x = deep;\n' },
    ]);

    const { graph, warnings } = await buildGraph(root);

    expect(warnings).toEqual([]);
    expect(graph.files.map((file) => file.id)).toHaveLength(2);
    // The relative import resolves across the deep nesting: one edge.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].fromId).toBe("shallow.ts");
    expect(graph.edges[0].toId).toBe("l1/l2/l3/l4/l5/l6/deep.ts");
  });

  it("special-but-legal file names become nodes with exact ids", async () => {
    const root = makeTempDir("citycode-weird-");
    dirs.push(root);
    writeFiles(root, [
      { path: "weird name[].ts", contents: "export function w() {}\n" },
      { path: "dots.in.name.ts", contents: "export function d() {}\n" },
      { path: "plus+and%25.ts", contents: "export function p() {}\n" },
    ]);

    const { graph, warnings } = await buildGraph(root);

    expect(warnings).toEqual([]);
    expect(graph.files.map((file) => file.id).sort()).toEqual([
      "dots.in.name.ts",
      "plus+and%25.ts",
      "weird name[].ts",
    ]);
  });

  it("file ids stay case-sensitive across different directories (POSIX parity)", async () => {
    // Windows folds case in the filesystem, so the two files must live in
    // SEPARATE directories — the assertion is about the graph ids, which
    // must keep the exact on-disk case either way.
    const root = makeTempDir("citycode-case-");
    dirs.push(root);
    writeFiles(root, [
      { path: "upper/Case.ts", contents: "export function u() {}\n" },
      { path: "lower/case.ts", contents: "export function l() {}\n" },
    ]);

    const { graph } = await buildGraph(root);

    expect(graph.files.map((file) => file.id).sort()).toEqual(["lower/case.ts", "upper/Case.ts"]);
  });

  it("a unicode folder name parses fine", async () => {
    const root = makeTempDir("citycode-日本語-");
    dirs.push(root);
    writeFiles(root, [
      { path: "日本語/a.ts", contents: "export function jp() { return 1; }\n" },
    ]);

    const { graph, warnings } = await buildGraph(root);

    expect(warnings).toEqual([]);
    expect(graph.files.map((file) => file.id)).toEqual(["日本語/a.ts"]);
  });

  it("a long absolute path (200+ chars) parses without throwing when creatable", async () => {
    const root = makeTempDir("citycode-long-");
    // Build a deep relative path whose total length comfortably exceeds
    // 200 characters. Creation may itself fail on a platform without long
    // paths — in that case the guard simply isn't exercised.
    const segments = Array.from({ length: 30 }, (_, i) => `seg${String(i).padStart(2, "0")}`);
    const relative = segments.join("/");
    try {
      writeFiles(root, [{ path: `${relative}/deep.ts`, contents: "export function deep() {}\n" }]);
    } catch {
      expect(true).toBe(true); // platform refused to create — nothing to assert
      dirs.push(root);
      return;
    }
    dirs.push(root);
    expect(path.resolve(path.join(root, relative)).length).toBeGreaterThan(200);

    const { graph, warnings } = await buildGraph(root);
    expect(warnings).toEqual([]);
    expect(graph.files).toHaveLength(1);
  });
});
