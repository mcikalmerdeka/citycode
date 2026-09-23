import { describe, expect, it } from "vitest";
import type { ExtractedImport } from "../lib/parser/extract";
import { resolveImports } from "../lib/parser/resolve";

/**
 * Pure unit tests for the import-resolution seam — no WASM, no filesystem.
 * `knownIds` stands in for the set of FileNode ids discovered by the walker.
 */
const knownIds = new Set([
  "util.ts",
  "helpers/index.ts",
  "comp.tsx",
  "src/a/b.ts",
  "src/sibling.ts",
  "src/mod.ts",
]);

function imp(specifier: string, symbols: string[] = []): ExtractedImport {
  return { specifier, symbols };
}

describe("resolveImports — relative resolution variants", () => {
  it("resolves an extension-less relative import to the .ts file", () => {
    const result = resolveImports("main.ts", [imp("./util", ["helper"])], knownIds);
    expect(result.edges).toEqual([{ fromId: "main.ts", toId: "util.ts", symbol: "helper" }]);
    expect(result.external).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves an extension-ful relative import as-is", () => {
    const result = resolveImports("main.ts", [imp("./util.ts", ["helper"])], knownIds);
    expect(result.edges).toEqual([{ fromId: "main.ts", toId: "util.ts", symbol: "helper" }]);
  });

  it("resolves a directory import to index.ts", () => {
    const result = resolveImports("main.ts", [imp("./helpers", ["helper"])], knownIds);
    expect(result.edges).toEqual([{ fromId: "main.ts", toId: "helpers/index.ts", symbol: "helper" }]);
  });

  it("resolves to a .tsx candidate when no .ts file exists", () => {
    const result = resolveImports("main.ts", [imp("./comp", ["Comp"])], knownIds);
    expect(result.edges).toEqual([{ fromId: "main.ts", toId: "comp.tsx", symbol: "Comp" }]);
  });

  it("resolves ../ specifiers from nested files", () => {
    const result = resolveImports("src/a/b.ts", [imp("../sibling", ["x"])], knownIds);
    expect(result.edges).toEqual([{ fromId: "src/a/b.ts", toId: "src/sibling.ts", symbol: "x" }]);
  });

  it("resolves a bare (symbol-less) ../ import to a single edge with no symbol", () => {
    const result = resolveImports("src/a/b.ts", [imp("../mod")], knownIds);
    expect(result.edges).toEqual([{ fromId: "src/a/b.ts", toId: "src/mod.ts" }]);
    expect(result.edges[0]?.symbol).toBeUndefined();
  });
});

describe("resolveImports — unresolved and external specifiers", () => {
  it("marks a relative import that escapes the repo root as unresolved", () => {
    const result = resolveImports("src/a/b.ts", [imp("../../escape", ["x"])], knownIds);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual(["../../escape"]);
  });

  it("marks a relative import matching no candidate as unresolved (no edge, no crash)", () => {
    const result = resolveImports("main.ts", [imp("./missing", ["x"])], knownIds);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toEqual(["./missing"]);
  });

  it("records bare package specifiers as external and never creates edges", () => {
    const result = resolveImports("main.ts", [imp("react", ["useState"])], knownIds);
    expect(result.edges).toEqual([]);
    expect(result.external).toEqual(["react"]);
    expect(result.unresolved).toEqual([]);
  });

  it("records tsconfig path aliases as external (alias resolution is out of scope)", () => {
    const result = resolveImports("main.ts", [imp("@/lib/x", ["y"])], knownIds);
    expect(result.edges).toEqual([]);
    expect(result.external).toEqual(["@/lib/x"]);
  });
});

describe("resolveImports — edge shape and determinism", () => {
  it("creates one bare edge (symbol omitted) for side-effect / default / namespace imports", () => {
    const result = resolveImports("main.ts", [imp("./util"), imp("./util.ts")], knownIds);
    expect(result.edges).toEqual([{ fromId: "main.ts", toId: "util.ts" }]);
  });

  it("creates one edge per named symbol", () => {
    const result = resolveImports("main.ts", [imp("./util", ["a", "b"])], knownIds);
    expect(result.edges).toEqual([
      { fromId: "main.ts", toId: "util.ts", symbol: "a" },
      { fromId: "main.ts", toId: "util.ts", symbol: "b" },
    ]);
  });

  it("dedupes identical edges from repeated import statements", () => {
    const result = resolveImports("main.ts", [imp("./util", ["a"]), imp("./util.ts", ["a"])], knownIds);
    expect(result.edges).toEqual([{ fromId: "main.ts", toId: "util.ts", symbol: "a" }]);
  });

  it("dedupes and sorts external and unresolved specifiers", () => {
    const result = resolveImports(
      "main.ts",
      [imp("zeta"), imp("alpha"), imp("zeta"), imp("./nope"), imp("./nope")],
      knownIds
    );
    expect(result.external).toEqual(["alpha", "zeta"]);
    expect(result.unresolved).toEqual(["./nope"]);
  });

  it("returns edges sorted by (toId, symbol) regardless of statement order", () => {
    const result = resolveImports("main.ts", [imp("./util", ["z"]), imp("./comp", ["c"]), imp("./util", ["a"])], knownIds);
    expect(result.edges).toEqual([
      { fromId: "main.ts", toId: "comp.tsx", symbol: "c" },
      { fromId: "main.ts", toId: "util.ts", symbol: "a" },
      { fromId: "main.ts", toId: "util.ts", symbol: "z" },
    ]);
  });
});
