import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { buildGraph } from "../lib/parser/buildGraph";
import type { CodeGraph } from "../lib/types";
import { cleanup, initRepo, makeTempDir, writeFiles } from "./helpers/fixtures";

/**
 * Phase 1 acceptance criteria from PROJECT_PLAN.md:
 * 1. Main fixture (3 folders, ~10 TS files, cross-imports, one external
 *    import) → every file a node, every intra-repo import an edge,
 *    zero node_modules nodes
 * 2. Same folder parsed twice → byte-identical graph JSON
 * 3. Parsing CityCode's own lib/ completes without error (dogfood)
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
});

/** The plan's main fixture: 3 folders, 10 TS files, cross-folder imports, 1 external import. */
function makeMainFixture(root: string): void {
  writeFiles(root, [
    { path: "src/core/engine.ts", contents: 'export function start(): string {\n  return "engine";\n}\n\nexport function stop(): void {}\n' },
    { path: "src/core/config.ts", contents: 'export const version = "1.0.0";\n' },
    { path: "src/core/util.ts", contents: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' },
    { path: "src/services/api.ts", contents: 'import { start, stop } from "../core/engine";\nimport config from "./settings";\n\nexport function serve(): string {\n  start();\n  return `serving ${config.port}`;\n}\n\nexport function shutdown(): void {\n  stop();\n}\n' },
    { path: "src/services/settings.ts", contents: 'export default { port: 3000 };\n' },
    { path: "src/services/logger.ts", contents: 'import { add } from "../core/util";\n\nexport function log(label: string): number {\n  return add(label.length, 1);\n}\n' },
    { path: "src/ui/panel.tsx", contents: 'import { serve } from "../services/api";\nimport type { ButtonHTMLAttributes } from "react";\n\nexport function renderPanel(props: ButtonHTMLAttributes<HTMLButtonElement>): string {\n  return `${serve()} ${props.className ?? ""}`;\n}\n' },
    { path: "src/ui/theme.tsx", contents: 'export const colors = { primary: "#05f" };\n' },
    { path: "src/index.ts", contents: 'import { serve } from "./services/api";\nimport { colors } from "./ui/theme";\nimport { existsSync } from "node:fs";\n\nexport function main(): string {\n  existsSync(".");\n  return serve() + colors.primary;\n}\n' },
    { path: "src/legacy/deprecated.ts", contents: 'import { start } from "../core/engine";\n\nexport function legacyCall(): void {\n  start();\n}\n' },
  ]);
}

describe("Phase 1 acceptance — main fixture", () => {
  it("every file a node, every intra-repo import an edge, zero node_modules nodes, real headSha", async () => {
    const root = makeTempDir("citycode-accept-");
    dirs.push(root);
    makeMainFixture(root);
    // node_modules content must never leak into the graph
    writeFiles(root, [{ path: "node_modules/somepkg/index.ts", contents: "export const x = 1;\n" }]);
    const expectedSha = await initRepo(root);

    const { graph, warnings } = await buildGraph(root);

    expect(warnings).toEqual([]);
    // every source file a node — exactly the 10 fixture files, zero node_modules
    const ids = graph.files.map((f) => f.id);
    expect(ids).toHaveLength(10);
    expect(ids.filter((id) => id.includes("node_modules"))).toEqual([]);

    // every intra-repo import becomes ≥1 edge (fromId = importer → toId = imported)
    const edgePairs = graph.edges.map((e) => `${e.fromId}->${e.toId}`);
    expect(edgePairs).toContain("src/services/api.ts->src/core/engine.ts");
    expect(edgePairs).toContain("src/services/api.ts->src/services/settings.ts");
    expect(edgePairs).toContain("src/services/logger.ts->src/core/util.ts");
    expect(edgePairs).toContain("src/ui/panel.tsx->src/services/api.ts");
    expect(edgePairs).toContain("src/index.ts->src/services/api.ts");
    expect(edgePairs).toContain("src/index.ts->src/ui/theme.tsx");
    expect(edgePairs).toContain("src/legacy/deprecated.ts->src/core/engine.ts");
    // direction check: fromId is always the importer
    for (const edge of graph.edges) {
      expect(ids).toContain(edge.fromId);
      expect(ids).toContain(edge.toId);
    }

    // external imports (bare packages + node: scheme + default-import record) are recorded, never edges
    const index = graph.files.find((f) => f.id === "src/index.ts");
    expect(index?.externalImports).toContain("node:fs");
    const panel = graph.files.find((f) => f.id === "src/ui/panel.tsx");
    expect(panel?.externalImports).toContain("react");

    // git fixture → real HEAD sha
    expect(graph.headSha).toBe(expectedSha);
    expect(graph.source).toBe("local");
    expect(graph.repoPath).toBe(path.resolve(root).split(path.sep).join("/"));
  });
});

describe("Phase 1 acceptance — determinism", () => {
  it("same folder parsed twice → byte-identical graph JSON", async () => {
    const root = makeTempDir("citycode-determin-");
    dirs.push(root);
    makeMainFixture(root);

    const first: CodeGraph = (await buildGraph(root)).graph;
    const second: CodeGraph = (await buildGraph(root)).graph;

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("Phase 1 acceptance — dogfood", () => {
  it("parsing CityCode's own lib/ completes without error", async () => {
    const libDir = path.resolve(import.meta.dirname, "..", "lib");

    const { graph, warnings } = await buildGraph(libDir);

    // every real lib/ module parsed as a node with forward-slash ids
    const ids = graph.files.map((f) => f.id);
    expect(ids).toContain("types.ts");
    expect(ids).toContain("git/local.ts");
    expect(ids).toContain("parser/extract.ts");
    expect(ids).toContain("parser/resolve.ts");
    expect(ids).toContain("parser/buildGraph.ts");
    expect(ids).toContain("parser/sitter.ts");
    // lib/ modules import each other via relative paths — real edges exist
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.every((e) => ids.includes(e.fromId) && ids.includes(e.toId))).toBe(true);
    expect(warnings).toEqual([]);
  });
});
