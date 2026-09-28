import { describe, expect, it } from "vitest";
import { computeCityLayout } from "@/lib/city/layout";
import type { Building, CityLayout } from "@/lib/city/layout";
import { derivePathNetwork } from "@/lib/city/paths";
import { deriveStreetNetwork, STREET_NODE_STEP, STREET_WIDTH } from "@/lib/city/streets";
import { buildRoadGraph } from "@/lib/sim/vehicles";
import type { CodeGraph, FileNode, ImportEdge } from "@/lib/types";

// ---------------------------------------------------------------------------
// derivePathNetwork — the pure, deterministic derivation of the walkable
// sidewalk graph + road polylines from a CityLayout. Fixtures are small
// hand-built layouts (and one real computeCityLayout output) so every rule
// below is asserted on known geometry.
// ---------------------------------------------------------------------------

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

/** 2×2 districts (4 top-level folders), 8 buildings, 3 import edges. */
function fixtureGraph(): CodeGraph {
  const files: FileNode[] = [
    file("a/one.ts", 40, 2),
    file("a/two.ts", 20, 1),
    file("b/one.ts", 60, 3),
    file("b/two.ts", 30, 2),
    file("c/one.ts", 10, 1),
    file("c/two.ts", 50, 2),
    file("d/one.ts", 25, 1),
    file("d/two.ts", 15, 1),
  ];
  const edges: ImportEdge[] = [
    { fromId: "a/one.ts", toId: "b/one.ts", symbol: "x" },
    { fromId: "b/two.ts", toId: "c/one.ts", symbol: "y" },
    { fromId: "c/two.ts", toId: "d/one.ts", symbol: "z" },
  ];
  return {
    files,
    edges,
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    repoPath: "C:/repos/demo",
    source: "local",
  };
}

function fixtureLayout(): CityLayout {
  return computeCityLayout(fixtureGraph());
}

/** Hand-built minimal layout: one district, two buildings, one road. */
function tinyLayout(): CityLayout {
  return {
    buildings: [
      { fileId: "a.ts", x: -10, z: -10, w: 4, d: 4, h: 5 },
      { fileId: "b.ts", x: 10, z: 10, w: 4, d: 4, h: 5 },
    ],
    districts: [{ path: "lib", x: 0, z: 0, w: 20, d: 20, depth: 0, label: "lib" }],
    roads: [{ fromId: "a.ts", toId: "b.ts", points: [{ x: -10, z: -10 }, { x: 10, z: 10 }] }],
    repoPath: "/repo",
  };
}

/** Union-find over node ids — connectivity oracle for the sidewalk graph. */
function componentCount(nodes: { id: string }[], segments: { a: string; b: string }[]): number {
  const parent = new Map<string, string>();
  for (const node of nodes) parent.set(node.id, node.id);
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const segment of segments) union(segment.a, segment.b);
  const roots = new Set<string>();
  for (const node of nodes) roots.add(find(node.id));
  return roots.size;
}

describe("derivePathNetwork — determinism", () => {
  it("two calls on the same layout deep-equal", () => {
    const layout = fixtureLayout();
    expect(derivePathNetwork(layout)).toEqual(derivePathNetwork(layout));
  });

  it("two calls on a hand-built layout deep-equal", () => {
    expect(derivePathNetwork(tinyLayout())).toEqual(derivePathNetwork(tinyLayout()));
  });

  it("node ids are deterministic strings of the form sw-<x>-<z>", () => {
    const network = derivePathNetwork(tinyLayout());
    expect(network.sidewalk.nodes.length).toBeGreaterThan(0);
    for (const node of network.sidewalk.nodes) {
      // Coordinates may be negative — the minus sign is part of the id.
      expect(node.id).toMatch(/^sw--?\d+(\.\d+)?--?\d+(\.\d+)?$/);
    }
  });
});

describe("derivePathNetwork — connectivity", () => {
  it("sidewalk graph is a single connected component (fixture layout)", () => {
    const network = derivePathNetwork(fixtureLayout());
    expect(network.sidewalk.nodes.length).toBeGreaterThan(1);
    expect(componentCount(network.sidewalk.nodes, network.sidewalk.segments)).toBe(1);
  });

  it("sidewalk graph is connected even for a tiny hand-built layout", () => {
    const network = derivePathNetwork(tinyLayout());
    expect(componentCount(network.sidewalk.nodes, network.sidewalk.segments)).toBe(1);
  });

  it("every segment references existing node ids", () => {
    const network = derivePathNetwork(fixtureLayout());
    const ids = new Set(network.sidewalk.nodes.map((node) => node.id));
    for (const segment of network.sidewalk.segments) {
      expect(ids.has(segment.a)).toBe(true);
      expect(ids.has(segment.b)).toBe(true);
    }
  });
});

describe("derivePathNetwork — sanity", () => {
  it("no zero-length segments", () => {
    const network = derivePathNetwork(fixtureLayout());
    const byId = new Map(network.sidewalk.nodes.map((node) => [node.id, node]));
    for (const segment of network.sidewalk.segments) {
      const a = byId.get(segment.a);
      const b = byId.get(segment.b);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (a === undefined || b === undefined) continue;
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0);
    }
  });

  it("no duplicate segments (undirected)", () => {
    const network = derivePathNetwork(fixtureLayout());
    const seen = new Set<string>();
    for (const segment of network.sidewalk.segments) {
      const key = segment.a < segment.b ? `${segment.a}|${segment.b}` : `${segment.b}|${segment.a}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("no duplicate node ids", () => {
    const network = derivePathNetwork(fixtureLayout());
    const ids = new Set<string>();
    for (const node of network.sidewalk.nodes) {
      expect(ids.has(node.id)).toBe(false);
      ids.add(node.id);
    }
  });
});

describe("derivePathNetwork — buildings stay walkable-free", () => {
  it("no sidewalk node sits inside a building footprint (fixture)", () => {
    const layout = fixtureLayout();
    const network = derivePathNetwork(layout);
    for (const node of network.sidewalk.nodes) {
      for (const building of layout.buildings) {
        const inside =
          node.x > building.x - building.w / 2 &&
          node.x < building.x + building.w / 2 &&
          node.z > building.z - building.d / 2 &&
          node.z < building.z + building.d / 2;
        expect(inside, `${node.id} inside ${building.fileId}`).toBe(false);
      }
    }
  });

  it("no sidewalk node sits inside a building footprint (tiny layout)", () => {
    const layout = tinyLayout();
    const network = derivePathNetwork(layout);
    for (const node of network.sidewalk.nodes) {
      for (const building of layout.buildings) {
        const inside =
          node.x > building.x - building.w / 2 &&
          node.x < building.x + building.w / 2 &&
          node.z > building.z - building.d / 2 &&
          node.z < building.z + building.d / 2;
        expect(inside).toBe(false);
      }
    }
  });
});

describe("derivePathNetwork — roads", () => {
  it("one RoadPolyline per derived corridor, with consistent width", () => {
    const layout = fixtureLayout();
    const network = derivePathNetwork(layout);
    expect(network.roads).toHaveLength(deriveStreetNetwork(layout).corridors.length);
    const widths = new Set(network.roads.map((road) => road.width));
    expect(widths.size).toBe(1);
    const width = network.roads[0]?.width ?? 0;
    expect(width).toBeGreaterThan(4);
    expect(width).toBeLessThan(10);
  });

  it("road ids are stable and unique", () => {
    const network = derivePathNetwork(fixtureLayout());
    const ids = new Set<string>();
    for (const road of network.roads) {
      expect(ids.has(road.id)).toBe(false);
      ids.add(road.id);
    }
    expect(ids.size).toBe(network.roads.length);
  });

  it("road polylines keep their corridor's endpoints (same count, same ends)", () => {
    const layout = fixtureLayout();
    const network = derivePathNetwork(layout);
    const corridors = deriveStreetNetwork(layout).corridors;
    expect(network.roads.length).toBe(corridors.length);
    for (let i = 0; i < corridors.length; i++) {
      const road = network.roads[i];
      const corridor = corridors[i];
      expect(road).toBeDefined();
      if (road === undefined) continue;
      const first = road.points[0];
      const last = road.points[road.points.length - 1];
      const startAlong = corridor.axis === "x" ? first?.z : first?.x;
      const endAlong = corridor.axis === "x" ? last?.z : last?.x;
      expect(startAlong).toBeCloseTo(corridor.from, 6);
      expect(endAlong).toBeCloseTo(corridor.to, 6);
    }
  });

  it("roads are non-empty even when the layout has no roads", () => {
    const layout = tinyLayout();
    const empty: CityLayout = { ...layout, roads: [] };
    const network = derivePathNetwork(empty);
    expect(network.roads.length).toBeGreaterThan(0);
    expect(network.sidewalk.nodes.length).toBeGreaterThan(0);
  });
});

describe("derivePathNetwork — sidewalk geometry follows the layout", () => {
  it("sidewalk nodes hug district boundaries or street sides (the documented contract)", () => {
    const layout = fixtureLayout();
    const corridors = deriveStreetNetwork(layout).corridors;
    const network = derivePathNetwork(layout);
    // A node is legal if it sits near a district edge OR near a street
    // corridor centreline (within the pavement-middle offset + slack) —
    // street-side sidewalks legitimately extend beyond district boundaries.
    for (const node of network.sidewalk.nodes) {
      const nearDistrict = layout.districts.some((district) => {
        // Ring nodes sit OUTSIDE the edge by SIDEWALK_OFFSET (2.5), so the
        // tolerance must exceed the offset, not the edge itself.
        const nearX =
          Math.abs(node.x - (district.x - district.w / 2)) < 3 ||
          Math.abs(node.x - (district.x + district.w / 2)) < 3;
        const nearZ =
          Math.abs(node.z - (district.z - district.d / 2)) < 3 ||
          Math.abs(node.z - (district.z + district.d / 2)) < 3;
        return nearX || nearZ;
      });
      // Point-to-centreline distance: pavement strips ride parallel to their
      // corridor at pavementOffset (4.8), so the tolerance exceeds that.
      const nearStreet = corridors.some((corridor) => {
        const across = corridor.axis === "x" ? node.x - corridor.center : node.z - corridor.center;
        const along = corridor.axis === "x" ? node.z : node.x;
        const pavement = STREET_WIDTH / 2 + 0.6 + 2.4 / 2;
        return Math.abs(across) <= pavement + 1 && along >= corridor.from - 1 && along <= corridor.to + 1;
      });
      expect(nearDistrict || nearStreet, `${node.id} not near any district edge or street`).toBe(true);
    }
  });

  it("sidewalk nodes exist on both sides of each street (tiny layout)", () => {
    const network = derivePathNetwork(tinyLayout());
    // The single district's perimeter ring runs at |x|,|z| = 7 with pavement
    // strips offset ±4.8; nodes exist on both flanks of every corridor.
    const left = network.sidewalk.nodes.some((node) => node.x - node.z < -1);
    const right = network.sidewalk.nodes.some((node) => node.x - node.z > 1);
    expect(left).toBe(true);
    expect(right).toBe(true);
  });
});

describe("derivePathNetwork — degenerate inputs", () => {
  it("empty layout (no buildings, no districts) yields an empty but valid network", () => {
    const layout: CityLayout = {
      buildings: [],
      districts: [],
      roads: [],
      repoPath: "/repo",
    };
    const network = derivePathNetwork(layout);
    expect(network.sidewalk.nodes).toHaveLength(0);
    expect(network.sidewalk.segments).toHaveLength(0);
    expect(network.roads).toHaveLength(0);
  });

  it("buildings without districts still produce a connected network", () => {
    const layout: CityLayout = {
      buildings: [
        { fileId: "x.ts", x: 0, z: 0, w: 2, d: 2, h: 3 },
        { fileId: "y.ts", x: 30, z: 0, w: 2, d: 2, h: 3 },
      ],
      districts: [],
      roads: [],
      repoPath: "/repo",
    };
    const network = derivePathNetwork(layout);
    expect(network.sidewalk.nodes.length).toBeGreaterThan(0);
    expect(componentCount(network.sidewalk.nodes, network.sidewalk.segments)).toBe(1);
  });
});

/** Re-exported type check: Building is used by the fixture builders above. */
export type { Building };

describe("derivePathNetwork — streets, not import edges", () => {
  it("emits road polylines for corridors even when the layout has zero roads", () => {
    const layout = { ...fixtureLayout(), roads: [] };
    const network = derivePathNetwork(layout);
    expect(network.roads.length).toBeGreaterThan(0);
    expect(network.roads.every((r) => r.id.startsWith("st-"))).toBe(true);
  });

  it("emits exactly one road polyline per derived corridor", () => {
    const layout = fixtureLayout();
    const network = derivePathNetwork(layout);
    expect(network.roads).toHaveLength(deriveStreetNetwork(layout).corridors.length);
  });

  it("gives every road polyline the shared STREET_WIDTH", () => {
    const network = derivePathNetwork(fixtureLayout());
    for (const r of network.roads) expect(r.width).toBe(STREET_WIDTH);
  });

  it("keeps the sidewalk graph a single connected component", () => {
    const network = derivePathNetwork(fixtureLayout());
    expect(componentCount(network.sidewalk.nodes, network.sidewalk.segments)).toBe(1);
  });

  it("samples road polylines no further apart than STREET_NODE_STEP", () => {
    const network = derivePathNetwork(fixtureLayout());
    for (const r of network.roads) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i];
        const b = r.points[i + 1];
        expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(STREET_NODE_STEP + 1e-6);
      }
    }
  });

  it("welds crossing corridors so the vehicle graph stays connected", () => {
    const network = derivePathNetwork(fixtureLayout());
    const graph = buildRoadGraph(network);
    const parent = graph.nodes.map((_, i) => i);
    const find = (x: number): number => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== root) {
        const next = parent[x];
        parent[x] = root;
        x = next;
      }
      return root;
    };
    for (let i = 0; i < graph.adj.length; i++) {
      for (const j of graph.adj[i]) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
    const roots = new Set(graph.nodes.map((_, i) => find(i)));
    expect(roots.size).toBe(1);
  });

  it("still falls back to a perimeter loop for a district-less layout", () => {
    const network = derivePathNetwork({ ...fixtureLayout(), districts: [] });
    expect(network.sidewalk.nodes.length).toBeGreaterThan(0);
  });
});
