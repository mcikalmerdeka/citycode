import { describe, expect, it } from "vitest";
import { computeCityLayout } from "@/lib/city/layout";
import type { Building, CityLayout, District } from "@/lib/city/layout";
import type { CodeGraph, FileNode, ImportEdge } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures — pure inline CodeGraph objects. computeCityLayout is a pure
// function, so unlike buildGraph's tests these never touch the filesystem.
// ---------------------------------------------------------------------------

/** FileNode factory: functions are synthetic — only their COUNT matters to the layout. */
function file(id: string, loc: number, functionCount: number): FileNode {
  return {
    id,
    path: id,
    loc,
    language: id.endsWith(".tsx") ? "tsx" : "typescript",
    functions: Array.from({ length: functionCount }, (_, i) => ({
      name: `fn${i + 1}`,
      startLine: i + 1,
      endLine: i + 2,
    })),
    externalImports: [],
    unresolvedImports: [],
  };
}

/**
 * Mirrors CityCode's own shape: lib/, lib/parser/, lib/git/, app/, a 0-loc
 * file, a depth-3 district chain, and root-level files — sorted by id, edges
 * sorted by (fromId, toId), exactly as the graph builder emits them.
 */
const DEMO_FILES: FileNode[] = [
  file("app/api/analyze/route.ts", 60, 1),
  file("app/page.tsx", 40, 2),
  file("empty.ts", 0, 0),
  file("lib/city/layout.ts", 139, 1),
  file("lib/git/local.ts", 120, 6),
  file("lib/parser/ast/walk.ts", 30, 2),
  file("lib/parser/buildGraph.ts", 150, 5),
  file("lib/parser/extract.ts", 80, 4),
  file("lib/parser/sitter/wasm/init.ts", 25, 1),
  file("lib/types.ts", 106, 3),
  file("root.ts", 10, 2),
];

const DEMO_EDGES: ImportEdge[] = [
  { fromId: "app/api/analyze/route.ts", toId: "lib/city/layout.ts", symbol: "computeCityLayout" },
  { fromId: "app/api/analyze/route.ts", toId: "lib/parser/buildGraph.ts", symbol: "buildGraph" },
  { fromId: "app/page.tsx", toId: "lib/city/layout.ts", symbol: "computeCityLayout" },
  { fromId: "empty.ts", toId: "lib/types.ts", symbol: "CodeGraph" },
  { fromId: "lib/city/layout.ts", toId: "lib/types.ts", symbol: "CodeGraph" },
  { fromId: "lib/parser/buildGraph.ts", toId: "lib/parser/extract.ts", symbol: "extractFromFile" },
  { fromId: "lib/parser/buildGraph.ts", toId: "lib/types.ts", symbol: "FileNode" },
  { fromId: "lib/parser/extract.ts", toId: "lib/parser/sitter/wasm/init.ts", symbol: "initSitter" },
  { fromId: "root.ts", toId: "empty.ts", symbol: "nothing" },
  { fromId: "root.ts", toId: "lib/types.ts", symbol: "CodeGraph" },
];

const EXPECTED_DISTRICT_PATHS = [
  "app",
  "app/api",
  "app/api/analyze",
  "lib",
  "lib/city",
  "lib/git",
  "lib/parser",
  "lib/parser/ast",
  "lib/parser/sitter",
  "lib/parser/sitter/wasm",
];

/** Deep clone so no test can pollute another through shared references. */
function demoGraph(): CodeGraph {
  return {
    files: DEMO_FILES.map((f) => ({ ...f, functions: f.functions.map((s) => ({ ...s })) })),
    edges: DEMO_EDGES.map((e) => ({ ...e })),
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    repoPath: "C:/repos/demo",
    source: "local",
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers — mirror the documented rules (4:3 root rectangle,
// depth-scaled padding capped at a quarter of each dimension) so containment
// is checked against the same regions the engine partitioned.
// ---------------------------------------------------------------------------

const DEFAULT_TOTAL_AREA = 40000;
const DEFAULT_DISTRICT_PADDING = 2;
const ROOT_W = Math.sqrt(DEFAULT_TOTAL_AREA * (4 / 3));
const ROOT_D = Math.sqrt(DEFAULT_TOTAL_AREA * (3 / 4));
/** Cells tile their region up to float dust; containment checks allow for it. */
const EPSILON = 1e-9;

interface Bbox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const ROOT_BBOX: Bbox = { minX: -ROOT_W / 2, maxX: ROOT_W / 2, minZ: -ROOT_D / 2, maxZ: ROOT_D / 2 };

function buildingBbox(building: Building): Bbox {
  return {
    minX: building.x - building.w / 2,
    maxX: building.x + building.w / 2,
    minZ: building.z - building.d / 2,
    maxZ: building.z + building.d / 2,
  };
}

function districtBbox(district: District): Bbox {
  return {
    minX: district.x - district.w / 2,
    maxX: district.x + district.w / 2,
    minZ: district.z - district.d / 2,
    maxZ: district.z + district.d / 2,
  };
}

/** The region a district's children were partitioned into (documented inset rule). */
function districtContentBbox(district: District): Bbox {
  const pad = Math.min(
    DEFAULT_DISTRICT_PADDING * (1 + 0.5 * district.depth),
    district.w / 4,
    district.d / 4,
  );
  const box = districtBbox(district);
  return { minX: box.minX + pad, maxX: box.maxX - pad, minZ: box.minZ + pad, maxZ: box.maxZ - pad };
}

function contains(outer: Bbox, inner: Bbox): boolean {
  return (
    inner.minX >= outer.minX - EPSILON &&
    inner.maxX <= outer.maxX + EPSILON &&
    inner.minZ >= outer.minZ - EPSILON &&
    inner.maxZ <= outer.maxZ + EPSILON
  );
}

function dirname(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
}

/** Walks every number in the layout and collects non-finite ones (NaN, ±Infinity). */
function nonFiniteNumbers(value: unknown, trail: string, problems: string[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      problems.push(`${trail} = ${String(value)}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) => nonFiniteNumbers(entry, `${trail}[${i}]`, problems));
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      nonFiniteNumbers((value as Record<string, unknown>)[key], `${trail}.${key}`, problems);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCityLayout — structure", () => {
  it("throws the documented error for an empty graph", () => {
    const empty: CodeGraph = { files: [], edges: [], repoPath: "C:/repos/empty", source: "local" };
    expect(() => computeCityLayout(empty)).toThrow(
      "CityCode: cannot lay out an empty graph — no files",
    );
  });

  it("emits one building per file, one district per folder prefix, one road per edge", () => {
    const layout = computeCityLayout(demoGraph());
    expect(layout.buildings).toHaveLength(11);
    expect(layout.districts.map((d) => d.path)).toEqual(EXPECTED_DISTRICT_PATHS);
    expect(layout.roads).toHaveLength(10);
    expect(layout.repoPath).toBe("C:/repos/demo");
  });

  it("derives district labels and depths from the folder path", () => {
    const layout = computeCityLayout(demoGraph());
    const byPath = new Map(layout.districts.map((d) => [d.path, d] as const));
    expect(byPath.get("lib")?.label).toBe("lib");
    expect(byPath.get("lib")?.depth).toBe(0);
    expect(byPath.get("lib/parser")?.label).toBe("parser");
    expect(byPath.get("lib/parser")?.depth).toBe(1);
    expect(byPath.get("app/api/analyze")?.label).toBe("analyze");
    expect(byPath.get("app/api/analyze")?.depth).toBe(2);
    expect(byPath.get("lib/parser/sitter/wasm")?.label).toBe("wasm");
    expect(byPath.get("lib/parser/sitter/wasm")?.depth).toBe(3);
  });

  it("sorts buildings by fileId, districts by path (parents before children), roads by (fromId, toId)", () => {
    const layout = computeCityLayout(demoGraph());
    for (let i = 1; i < layout.buildings.length; i++) {
      expect(layout.buildings[i - 1].fileId < layout.buildings[i].fileId).toBe(true);
    }
    for (let i = 1; i < layout.districts.length; i++) {
      expect(layout.districts[i - 1].path < layout.districts[i].path).toBe(true);
    }
    for (let i = 1; i < layout.roads.length; i++) {
      const prev = layout.roads[i - 1];
      const curr = layout.roads[i];
      expect(
        prev.fromId < curr.fromId || (prev.fromId === curr.fromId && prev.toId <= curr.toId),
      ).toBe(true);
    }
    // Parents precede children in plain string order ("lib" < "lib/parser").
    const paths = layout.districts.map((d) => d.path);
    expect(paths.indexOf("lib")).toBeLessThan(paths.indexOf("lib/parser"));
    expect(paths.indexOf("app")).toBeLessThan(paths.indexOf("app/api/analyze"));
  });
});

describe("computeCityLayout — containment", () => {
  it("keeps every foldered building inside its district's padded content region", () => {
    const layout = computeCityLayout(demoGraph());
    const districtsByPath = new Map(layout.districts.map((d) => [d.path, d] as const));
    for (const building of layout.buildings) {
      const folder = dirname(building.fileId);
      if (folder === "") {
        continue; // root-level files belong to no district — covered by the next test
      }
      const district = districtsByPath.get(folder);
      expect(district).toBeDefined();
      if (district) {
        expect(contains(districtContentBbox(district), buildingBbox(building))).toBe(true);
      }
    }
  });

  it("keeps root-level files inside the root rectangle (they belong to no district)", () => {
    const layout = computeCityLayout(demoGraph());
    const rootLevel = layout.buildings.filter((b) => dirname(b.fileId) === "");
    expect(rootLevel.map((b) => b.fileId).sort()).toEqual(["empty.ts", "root.ts"]);
    for (const building of rootLevel) {
      expect(contains(ROOT_BBOX, buildingBbox(building))).toBe(true);
    }
  });

  it("keeps every child district inside its parent district's padded content region", () => {
    const layout = computeCityLayout(demoGraph());
    const districtsByPath = new Map(layout.districts.map((d) => [d.path, d] as const));
    for (const district of layout.districts) {
      const parentPath = dirname(district.path);
      if (parentPath === "") {
        // Top-level districts partition the unpadded root rectangle.
        expect(contains(ROOT_BBOX, districtBbox(district))).toBe(true);
        continue;
      }
      const parent = districtsByPath.get(parentPath);
      expect(parent).toBeDefined();
      if (parent) {
        expect(contains(districtContentBbox(parent), districtBbox(district))).toBe(true);
      }
    }
  });

  it("fully contains every building beneath a district, at any nesting depth", () => {
    const layout = computeCityLayout(demoGraph());
    for (const district of layout.districts) {
      const prefix = `${district.path}/`;
      const descendants = layout.buildings.filter((b) => b.fileId.startsWith(prefix));
      expect(descendants.length).toBeGreaterThan(0); // every district has files beneath it
      for (const building of descendants) {
        expect(contains(districtBbox(district), buildingBbox(building))).toBe(true);
      }
    }
    // Spot-check the deepest chain: lib/parser/sitter/wasm/init.ts inside "lib".
    const lib = layout.districts.find((d) => d.path === "lib");
    const deep = layout.buildings.find((b) => b.fileId === "lib/parser/sitter/wasm/init.ts");
    expect(lib).toBeDefined();
    expect(deep).toBeDefined();
    if (lib && deep) {
      expect(contains(districtBbox(lib), buildingBbox(deep))).toBe(true);
    }
  });
});

describe("computeCityLayout — roads", () => {
  it("draws each road as exactly two points: source center → target center", () => {
    const layout = computeCityLayout(demoGraph());
    const buildingsById = new Map(layout.buildings.map((b) => [b.fileId, b] as const));
    for (const road of layout.roads) {
      const from = buildingsById.get(road.fromId);
      const to = buildingsById.get(road.toId);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(road.points).toHaveLength(2);
      if (from && to) {
        expect(road.points[0]).toEqual({ x: from.x, z: from.z });
        expect(road.points[1]).toEqual({ x: to.x, z: to.z });
      }
    }
  });

  it("emits one road per edge — duplicate (fromId, toId) pairs keep both roads", () => {
    const graph: CodeGraph = {
      files: [file("a.ts", 10, 1), file("b.ts", 20, 2)],
      edges: [
        { fromId: "a.ts", toId: "b.ts", symbol: "one" },
        { fromId: "a.ts", toId: "b.ts", symbol: "two" },
      ],
      repoPath: "C:/repos/dup",
      source: "local",
    };
    const layout = computeCityLayout(graph);
    expect(layout.roads).toHaveLength(2);
    expect(layout.roads[0]).toEqual(layout.roads[1]); // same pair → identical geometry
  });

  it("skips edges whose endpoints never became files (malformed graph, no NaN)", () => {
    const graph: CodeGraph = {
      files: [file("a.ts", 10, 1)],
      edges: [{ fromId: "a.ts", toId: "ghost.ts", symbol: "boo" }],
      repoPath: "C:/repos/ghost",
      source: "local",
    };
    const layout = computeCityLayout(graph);
    expect(layout.roads).toEqual([]);
  });
});

describe("computeCityLayout — building metrics", () => {
  it("computes heights as max(0.5, 0.1·loc) — the only meaning height carries", () => {
    const layout = computeCityLayout(demoGraph());
    const locById = new Map(DEMO_FILES.map((f) => [f.id, f.loc] as const));
    for (const building of layout.buildings) {
      expect(building.h).toBe(Math.max(0.5, (locById.get(building.fileId) ?? 0) * 0.1));
    }
  });

  it("gives the 0-LOC file the 0.5 height floor and a positive footprint", () => {
    const layout = computeCityLayout(demoGraph());
    const empty = layout.buildings.find((b) => b.fileId === "empty.ts");
    expect(empty).toBeDefined();
    expect(empty?.h).toBe(0.5);
    expect(empty?.w).toBeGreaterThan(0);
    expect(empty?.d).toBeGreaterThan(0);
  });

  it("keeps footprint area at or under the LOC-proportional weight (area ∝ LOC)", () => {
    const layout = computeCityLayout(demoGraph());
    let totalLoc = 0;
    for (const f of DEMO_FILES) {
      totalLoc += f.loc;
    }
    const scale = DEFAULT_TOTAL_AREA / totalLoc;
    for (const building of layout.buildings) {
      const loc = DEMO_FILES.find((f) => f.id === building.fileId)?.loc ?? 0;
      const weight = Math.max(1, loc * scale); // minFootprint default
      expect(building.w).toBeGreaterThan(0);
      expect(building.d).toBeGreaterThan(0);
      expect(building.w * building.d).toBeLessThanOrEqual(weight + 1e-6);
    }
  });
});

describe("computeCityLayout — determinism & options", () => {
  it("is byte-identical across runs (JSON.stringify)", () => {
    expect(JSON.stringify(computeCityLayout(demoGraph()))).toBe(
      JSON.stringify(computeCityLayout(demoGraph())),
    );
  });

  it("treats an explicit options object equal to the defaults as identical", () => {
    const implicit = computeCityLayout(demoGraph());
    const explicit = computeCityLayout(demoGraph(), {
      totalArea: 40000,
      districtPadding: 2,
      heightPerLoc: 0.1,
      minFootprint: 1,
    });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
  });

  it("produces identical output from an unsorted (reversed) files and edges array", () => {
    const sorted = demoGraph();
    const shuffled = demoGraph();
    shuffled.files.reverse();
    shuffled.edges.reverse();
    expect(JSON.stringify(computeCityLayout(shuffled))).toBe(
      JSON.stringify(computeCityLayout(sorted)),
    );
  });

  it("honors a partial options object: heightPerLoc scales heights and nothing else", () => {
    const base = computeCityLayout(demoGraph());
    const scaled = computeCityLayout(demoGraph(), { heightPerLoc: 0.5 });
    const strip = (layout: CityLayout) =>
      layout.buildings.map((b) => ({ fileId: b.fileId, x: b.x, z: b.z, w: b.w, d: b.d }));
    expect(JSON.stringify(strip(scaled))).toBe(JSON.stringify(strip(base)));
    for (const building of scaled.buildings) {
      const loc = DEMO_FILES.find((f) => f.id === building.fileId)?.loc ?? 0;
      expect(building.h).toBe(Math.max(0.5, loc * 0.5));
    }
  });

  it("emits no NaN or Infinity anywhere in the layout", () => {
    const layout = computeCityLayout(demoGraph());
    const problems: string[] = [];
    nonFiniteNumbers(layout, "layout", problems);
    expect(problems).toEqual([]);
    // JSON.stringify renders NaN/±Infinity as null — none may appear.
    expect(JSON.stringify(layout)).not.toContain("null");
  });
});

describe("computeCityLayout — edge shapes", () => {
  it("lays out a single-file repo: one building, no districts, no roads, inside the root rectangle", () => {
    const graph: CodeGraph = {
      files: [file("solo.ts", 42, 3)],
      edges: [],
      repoPath: "C:/repos/solo",
      source: "local",
    };
    const layout = computeCityLayout(graph);
    expect(layout.buildings).toHaveLength(1);
    expect(layout.districts).toEqual([]);
    expect(layout.roads).toEqual([]);
    const solo = layout.buildings[0];
    expect(solo.h).toBe(Math.max(0.5, 42 * 0.1));
    expect(contains(ROOT_BBOX, buildingBbox(solo))).toBe(true);
  });

  it("lays out a repo of only root-level files (no folders at all)", () => {
    const graph: CodeGraph = {
      files: [file("a.ts", 10, 1), file("b.ts", 300, 2), file("c.ts", 0, 0)],
      edges: [],
      repoPath: "C:/repos/flat",
      source: "local",
    };
    const layout = computeCityLayout(graph);
    expect(layout.districts).toEqual([]);
    expect(layout.buildings).toHaveLength(3);
    for (const building of layout.buildings) {
      expect(contains(ROOT_BBOX, buildingBbox(building))).toBe(true);
    }
  });
});
