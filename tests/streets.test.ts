import { describe, expect, it } from "vitest";
import { computeCityLayout } from "@/lib/city/layout";
import type { Building, CityLayout } from "@/lib/city/layout";
import { buildStreetGraph } from "@/lib/city/streetGraph";
import {
  STREET_WIDTH,
  deriveStreetNetwork,
  routeAlongStreets,
  type StreetCorridor,
  type StreetNetwork,
} from "@/lib/city/streets";
import type { CodeGraph, FileNode } from "@/lib/types";

// ---------------------------------------------------------------------------
// deriveStreetNetwork — the pure, deterministic derivation of the street grid
// from district rectangles. Fixtures are small hand-built layouts (plus one
// real computeCityLayout output) so every rule below is asserted on known
// geometry, mirroring the describe layout of tests/paths.test.ts.
// ---------------------------------------------------------------------------

/** Two blocks sharing a vertical edge at x=0: [x,z,w,d] tuples. */
const twoBlocks: CityLayout = {
  repoPath: "/r",
  buildings: [],
  districts: [
    { path: "a", x: -30, z: 0, w: 60, d: 40, label: "a", depth: 0 },
    { path: "b", x: 30, z: 0, w: 60, d: 40, label: "b", depth: 0 },
  ],
  roads: [],
};

function file(id: string, loc: number, functionCount: number): FileNode {
  return {
    id,
    path: id,
    loc,
    language: "typescript",
    functions: Array.from({ length: functionCount }, (_, i) => ({
      name: `fn${i + 1}`,
      startLine: i + 1,
      endLine: i + 2,
    })),
    externalImports: [],
    unresolvedImports: [],
  };
}

/** 3 top-level folders (one of them nested) — real treemap geometry. */
function nestedGraph(): CodeGraph {
  const files: FileNode[] = [
    file("a/one.ts", 40, 2),
    file("a/sub/one.ts", 25, 1),
    file("a/sub/two.ts", 15, 1),
    file("b/one.ts", 60, 3),
    file("b/two.ts", 30, 2),
    file("c/one.ts", 10, 1),
    file("c/two.ts", 50, 2),
  ];
  return {
    files,
    edges: [{ fromId: "a/one.ts", toId: "b/one.ts", symbol: "x" }],
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    repoPath: "/r",
    source: "local",
  };
}

/** A real layout (nested districts, real building footprints). */
function fixtureLayoutWithBuildings(): CityLayout {
  return computeCityLayout(nestedGraph());
}

function graphOf(entries: Array<[string, number, number]>): CodeGraph {
  return {
    files: entries.map(([id, loc, functionCount]) => file(id, loc, functionCount)),
    edges: [],
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    repoPath: "/r",
    source: "local",
  };
}

/**
 * A real layout three folders deep. Depth is what puts two parallel streets a
 * few units apart on a real treemap: each level's padding ring is wider than
 * the one inside it (4u at depth 0, 6u at depth 1, 8u at depth 2), so a child's
 * ring street lands just outside the shared edge it is cut from.
 */
function deeplyNestedLayout(): CityLayout {
  return computeCityLayout(
    graphOf([
      ["app/page.tsx", 200, 4],
      ["app/ui/Panel.tsx", 120, 3],
      ["app/ui/controls/Button.tsx", 60, 2],
      ["lib/core/engine.ts", 300, 8],
      ["lib/core/parts/wheel.ts", 90, 3],
      ["lib/aux/helper.ts", 80, 2],
      ["lib/aux/deep/extra.ts", 40, 1],
      ["tests/one.test.ts", 70, 2],
    ]),
  );
}

/**
 * Two sibling blocks 8u apart along X: the second one sits entirely to the
 * right of the first, so the pair's separation is a positive 8u gap — the shape
 * a parent's padding ring has when the child is cut away from an outside
 * neighbour. Nothing is nested here; the point is the gap.
 */
function eightUnitGap(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [],
    districts: [
      { path: "pkg", x: -20, z: 0, w: 40, d: 40, label: "pkg", depth: 0 },
      { path: "pkg/sub", x: 12, z: 0, w: 8, d: 8, label: "sub", depth: 1 },
    ],
    roads: [],
  };
}

/** Two blocks whose shared span is a fifth of a unit — a sub-unit street. */
function subUnitSpanLayout(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [],
    districts: [
      { path: "a", x: -5, z: -0.2, w: 10, d: 0.8, label: "a", depth: 0 },
      { path: "b", x: 5, z: 0.4, w: 10, d: 0.8, label: "b", depth: 0 },
    ],
    roads: [],
  };
}

/** 2×2 blocks meeting at the origin: one vertical and one horizontal street. */
function gridOfFour(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [],
    districts: [
      { path: "a", x: -20, z: -20, w: 40, d: 40, label: "a", depth: 0 },
      { path: "b", x: 20, z: -20, w: 40, d: 40, label: "b", depth: 0 },
      { path: "c", x: -20, z: 20, w: 40, d: 40, label: "c", depth: 0 },
      { path: "d", x: 20, z: 20, w: 40, d: 40, label: "d", depth: 0 },
    ],
    roads: [],
  };
}

/** Three of the four quadrants: two street candidates resolve to one corner. */
function threeBlocksMeetingAtACorner(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [],
    districts: [
      { path: "a", x: -20, z: -20, w: 40, d: 40, label: "a", depth: 0 },
      { path: "b", x: 20, z: -20, w: 40, d: 40, label: "b", depth: 0 },
      { path: "c", x: 20, z: 20, w: 40, d: 40, label: "c", depth: 0 },
    ],
    roads: [],
  };
}

/** Two adjacent blocks, one building each, both curbside on the shared street. */
function layoutWithTwoNamedBuildings(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [
      { fileId: "a", x: -10, z: 0, w: 4, d: 4, h: 3 },
      { fileId: "b", x: 10, z: 0, w: 4, d: 4, h: 3 },
    ],
    districts: [
      { path: "a", x: -30, z: 0, w: 48, d: 40, label: "a", depth: 0 },
      { path: "b", x: 30, z: 0, w: 48, d: 40, label: "b", depth: 0 },
    ],
    roads: [],
  };
}

/** A repo with no folders at all: buildings only, no district rectangles. */
function buildingsOnlyLayout(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [
      { fileId: "a.ts", x: -8, z: 0, w: 6, d: 6, h: 4 },
      { fileId: "b.ts", x: 8, z: 0, w: 6, d: 6, h: 4 },
    ],
    districts: [],
    roads: [],
  };
}

/** One block, one building: the smallest city that still needs a street. */
function singleBlockLayout(): CityLayout {
  return {
    repoPath: "/r",
    buildings: [{ fileId: "a.ts", x: 0, z: 0, w: 8, d: 8, h: 4 }],
    districts: [{ path: "lib", x: 0, z: 0, w: 40, d: 40, label: "lib", depth: 0 }],
    roads: [],
  };
}

/**
 * How far a building's footprint reaches past a corridor's kerb line, in world
 * units (the depth of the two tarmac/footprint intervals); negative when the
 * building clears the tarmac, or when the two do not overlap along the
 * corridor's own axis at all.
 */
function overlapOnAxis(corridor: StreetCorridor, building: Building): number {
  const half = corridor.width / 2;
  if (corridor.axis === "x") {
    if (building.z + building.d / 2 <= corridor.from || building.z - building.d / 2 >= corridor.to) {
      return -1;
    }
    return Math.min(building.x + building.w / 2, corridor.center + half) - Math.max(building.x - building.w / 2, corridor.center - half);
  }
  if (building.x + building.w / 2 <= corridor.from || building.x - building.w / 2 >= corridor.to) {
    return -1;
  }
  return Math.min(building.z + building.d / 2, corridor.center + half) - Math.max(building.z - building.d / 2, corridor.center - half);
}

describe("deriveStreetNetwork — determinism", () => {
  it("returns deep-equal output for the same layout", () => {
    expect(deriveStreetNetwork(twoBlocks)).toEqual(deriveStreetNetwork(twoBlocks));
  });

  it("returns the same network whatever order the layout arrays are in", () => {
    // Four downstream tasks rely on this: rects and districts are re-sorted by
    // path internally, so a caller that hands us an unsorted layout gets the
    // identical geometry — and the identical inset iteration order.
    const layout = deeplyNestedLayout();
    const reversed: CityLayout = {
      ...layout,
      buildings: layout.buildings.slice().reverse(),
      districts: layout.districts.slice().reverse(),
    };
    const straight = deriveStreetNetwork(layout);
    const shuffled = deriveStreetNetwork(reversed);
    expect(shuffled.corridors).toEqual(straight.corridors);
    expect(shuffled.intersections).toEqual(straight.intersections);
    expect(Array.from(shuffled.blockInsets.entries())).toEqual(
      Array.from(straight.blockInsets.entries()),
    );
  });
});

describe("deriveStreetNetwork — corridors", () => {
  it("emits one corridor on the shared edge of two touching blocks", () => {
    const net: StreetNetwork = deriveStreetNetwork(twoBlocks);
    const onSharedEdge = net.corridors.filter((c) => c.axis === "x" && Math.abs(c.center) < 1e-6);
    expect(onSharedEdge).toHaveLength(1);
    expect(onSharedEdge[0].center).toBe(0);
    expect(onSharedEdge[0].width).toBe(STREET_WIDTH);
  });

  it("rings the city with a perimeter street inset half a street inside the union", () => {
    const net = deriveStreetNetwork(twoBlocks);
    // twoBlocks spans x=-60..60 and z=-20..20, so the ring's two x-corridors sit
    // half a street inside the union's x edges and its two z-corridors half a
    // street inside the z edges. The shared-edge street at x=0 is pinned in the
    // same list (filtering on width alone would catch it too — it is exactly
    // STREET_WIDTH wide).
    const xs = net.corridors.filter((c) => c.axis === "x").map((c) => c.center).sort((a, b) => a - b);
    expect(xs).toEqual([-60 + STREET_WIDTH / 2, 0, 60 - STREET_WIDTH / 2]);
    const zs = net.corridors.filter((c) => c.axis === "z").map((c) => c.center).sort((a, b) => a - b);
    expect(zs).toEqual([-20 + STREET_WIDTH / 2, 20 - STREET_WIDTH / 2]);
    for (const corridor of net.corridors) {
      expect(corridor.width).toBe(STREET_WIDTH);
    }
  });

  it("gives an 8u gap a street exactly as wide as the gap", () => {
    // The gap rule owns the width here: the street sits at the gap's midpoint
    // (x=4, between the two block edges at 0 and 8) and its nearest parallel
    // neighbour — the ring edge at x=13 — is 9u away, so nothing narrows it and
    // the 8u gap keeps 8u of tarmac. (The module does NOT guarantee
    // width >= STREET_WIDTH in general; that is the parallel-neighbour clamp's
    // job, see below.)
    const street = deriveStreetNetwork(eightUnitGap()).corridors.find(
      (c) => c.axis === "x" && Math.abs(c.center - 4) < 1e-6,
    );
    expect(street).toBeDefined();
    expect(street?.width).toBe(8);
  });

  it("promotes a padding ring into a corridor as wide as the gap", () => {
    // 8u between the two blocks => a corridor 8u wide
    const net = deriveStreetNetwork(eightUnitGap());
    const ring = net.corridors.find((c) => c.width === 8);
    expect(ring).toBeDefined();
  });

  it("ignores gaps wider than MAX_STREET_WIDTH", () => {
    const wide: CityLayout = {
      ...twoBlocks,
      districts: [
        { path: "a", x: -60, z: 0, w: 40, d: 40, label: "a", depth: 0 },
        { path: "b", x: 60, z: 0, w: 40, d: 40, label: "b", depth: 0 },
      ],
    };
    expect(
      deriveStreetNetwork(wide).corridors.filter((c) => Math.abs(c.center) < 1),
    ).toHaveLength(0);
  });

  it("emits no zero-length corridor span", () => {
    // subUnitSpanLayout's street is 0.2u long, so a "long enough" bound would
    // be a lie; what the contract promises is a POSITIVE extent.
    for (const c of deriveStreetNetwork(subUnitSpanLayout()).corridors) {
      expect(c.to - c.from).toBeGreaterThan(0);
    }
    for (const c of deriveStreetNetwork(twoBlocks).corridors) {
      expect(c.to - c.from).toBeGreaterThan(0);
    }
  });

  it("merges duplicate corridors so three blocks at one corner yield one street", () => {
    const net = deriveStreetNetwork(threeBlocksMeetingAtACorner());
    const axisX = net.corridors.filter((c) => c.axis === "x" && Math.abs(c.center) < 1e-6);
    expect(axisX).toHaveLength(1);
  });

  it("never emits two corridors on the same axis and centre", () => {
    const net = deriveStreetNetwork(gridOfFour());
    const keys = net.corridors.map((c) => `${c.axis}:${c.center.toFixed(4)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never leaves two same-axis corridors closer than half a street", () => {
    // Two centrelines within STREET_WIDTH/2 are the same street seen from two
    // nesting levels (a shared edge and the parent ring beside it) — the merge
    // has to have folded them, or the renderer draws two ribbons on top of
    // each other.
    for (const layout of [eightUnitGap(), gridOfFour(), fixtureLayoutWithBuildings()]) {
      const corridors = deriveStreetNetwork(layout).corridors;
      for (let i = 0; i < corridors.length; i++) {
        for (let j = i + 1; j < corridors.length; j++) {
          const a = corridors[i];
          const b = corridors[j];
          if (a.axis !== b.axis) continue;
          expect(
            Math.abs(a.center - b.center),
            `same-axis corridors at ${a.center} and ${b.center}`,
          ).toBeGreaterThan(STREET_WIDTH / 2);
        }
      }
    }
  });

  it("never gives two overlapping-span same-axis streets overlapping tarmac", () => {
    // Distinct parallel streets (kept apart by the merge) share the space
    // between their centrelines, so each may claim at most its half of it.
    const layouts = [
      eightUnitGap(),
      gridOfFour(),
      fixtureLayoutWithBuildings(),
      deeplyNestedLayout(),
    ];
    for (const layout of layouts) {
      const net = deriveStreetNetwork(layout);
      for (let i = 0; i < net.corridors.length; i++) {
        for (let j = i + 1; j < net.corridors.length; j++) {
          const a = net.corridors[i];
          const b = net.corridors[j];
          if (a.axis !== b.axis) continue;
          const spanOverlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
          if (!(spanOverlap > 0)) continue;
          const gap = Math.abs(a.center - b.center);
          expect(
            a.width / 2 + b.width / 2,
            `${a.axis} streets at ${a.center} (w=${a.width}) and ${b.center} (w=${b.width}) are ${gap.toFixed(2)}u apart`,
          ).toBeLessThanOrEqual(gap + 1e-6);
        }
      }
    }
  });

  it("leaves a street alone when no parallel neighbour shares its space", () => {
    // Three blocks in a row with 8u gaps: the two gap streets end up 28u apart
    // and the ring 21u outside them, so nothing has to give up tarmac and the
    // gaps keep the full width the gap rule gave them.
    const row: CityLayout = {
      repoPath: "/r",
      buildings: [],
      districts: [
        { path: "a", x: -28, z: 0, w: 20, d: 20, label: "a", depth: 0 },
        { path: "b", x: 0, z: 0, w: 20, d: 20, label: "b", depth: 0 },
        { path: "c", x: 28, z: 0, w: 20, d: 20, label: "c", depth: 0 },
      ],
      roads: [],
    };
    const net = deriveStreetNetwork(row);
    const gapStreets = net.corridors.filter((c) => c.axis === "x" && Math.abs(Math.abs(c.center) - 14) < 1e-6);
    expect(gapStreets).toHaveLength(2);
    for (const corridor of gapStreets) {
      expect(corridor.width).toBe(8);
    }
    for (const corridor of net.corridors) {
      expect(corridor.width).toBeGreaterThanOrEqual(STREET_WIDTH);
    }
  });

  it("keeps every street at least half a street wide", () => {
    // The shared-space clamp can never reach below MERGE_TOLERANCE, because the
    // merge keeps same-axis centres further apart than that — so no street
    // degenerates into a sliver.
    for (const layout of [eightUnitGap(), gridOfFour(), deeplyNestedLayout()]) {
      for (const corridor of deriveStreetNetwork(layout).corridors) {
        expect(corridor.width).toBeGreaterThanOrEqual(STREET_WIDTH / 2);
      }
    }
  });

  it("narrows streets without merging or dropping any", () => {
    // Regression guard: the width clamp must not "fix" the overlap by
    // re-merging. Corridor identity — this exact count of distinct centrelines,
    // parallel pairs included — has to survive the clamp.
    expect(deriveStreetNetwork(deeplyNestedLayout()).corridors).toHaveLength(9);
  });
});

describe("deriveStreetNetwork — blocks stay clear of tarmac", () => {
  it("keeps every building footprint at most 1u inside a corridor", () => {
    const net = deriveStreetNetwork(fixtureLayoutWithBuildings());
    for (const b of fixtureLayoutWithBuildings().buildings) {
      for (const c of net.corridors) {
        const overlap = overlapOnAxis(c, b);
        if (overlap <= 0) continue;
        expect(overlap).toBeLessThanOrEqual(1);
      }
    }
  });

  it("clamps block insets so a small district never goes negative", () => {
    const tiny: CityLayout = {
      repoPath: "/r",
      buildings: [],
      districts: [{ path: "t", x: 0, z: 0, w: 9, d: 9, label: "t", depth: 0 }],
      roads: [],
    };
    for (const inset of deriveStreetNetwork(tiny).blockInsets.values()) {
      expect(inset.x).toBeLessThan(9 / 2);
      expect(inset.z).toBeLessThan(9 / 2);
    }
  });

  it("keeps the largest pull-back when several streets touch one block side", () => {
    // District a spans x[-60,0]. The ring street at x=-57 pushes its -X edge to
    // -54 (a 6u pull-back) while the shared-edge street at x=0 pushes only 3u.
    // The footprint repair for a building standing in that shared-edge street
    // must NOT shrink the block's -X inset to 3: that would leave the rendered
    // edge at -57, inside the ring's tarmac [-60,-54].
    const layout: CityLayout = {
      ...twoBlocks,
      buildings: [{ fileId: "onStreet", x: 0, z: 0, w: 10, d: 10, h: 3 }],
    };
    const insets = deriveStreetNetwork(layout).blockInsets;
    expect(insets.get("a")?.x).toBe(6);
  });
});

describe("deriveStreetNetwork — intersections", () => {
  it("finds where an x corridor crosses a z corridor", () => {
    const net = deriveStreetNetwork(gridOfFour());
    expect(net.intersections.some((i) => Math.abs(i.x) < 1e-6 && Math.abs(i.z) < 1e-6)).toBe(true);
  });
});

describe("deriveStreetNetwork — degenerate inputs", () => {
  it("returns a perimeter ring for a layout with no districts", () => {
    const net = deriveStreetNetwork(buildingsOnlyLayout());
    expect(net.corridors.length).toBeGreaterThanOrEqual(4);
  });

  it("returns four corridors for a single block", () => {
    const net = deriveStreetNetwork(singleBlockLayout());
    expect(net.corridors).toHaveLength(4);
  });

  it("returns no corridors for an empty layout", () => {
    const net = deriveStreetNetwork({ repoPath: "/r", buildings: [], districts: [], roads: [] });
    expect(net.corridors).toEqual([]);
    expect(net.intersections).toEqual([]);
  });

  it("returns no NaN or Infinity in any corridor field", () => {
    // Scanned on layouts that actually yield corridors, including sub-unit
    // coordinates, so a non-finite field anywhere would be caught.
    for (const layout of [
      buildingsOnlyLayout(),
      subUnitSpanLayout(),
      fixtureLayoutWithBuildings(),
      deeplyNestedLayout(),
    ]) {
      const net = deriveStreetNetwork(layout);
      expect(net.corridors.length).toBeGreaterThan(0);
      for (const c of net.corridors) {
        expect(Number.isFinite(c.center)).toBe(true);
        expect(Number.isFinite(c.width)).toBe(true);
        expect(Number.isFinite(c.from)).toBe(true);
        expect(Number.isFinite(c.to)).toBe(true);
      }
      for (const i of net.intersections) {
        expect(Number.isFinite(i.x)).toBe(true);
        expect(Number.isFinite(i.z)).toBe(true);
      }
    }
  });
});

describe("routeAlongStreets", () => {
  it("returns a polyline of at least 2 points between two connected blocks", () => {
    const layout = layoutWithTwoNamedBuildings();
    const net = deriveStreetNetwork(layout);
    const route = routeAlongStreets(net, layout.buildings[0], layout.buildings[1]);
    expect(route.length).toBeGreaterThanOrEqual(2);
  });

  it("starts at the importer and ends at the imported building", () => {
    const layout = layoutWithTwoNamedBuildings();
    const net = deriveStreetNetwork(layout);
    const [a, b] = layout.buildings;
    const route = routeAlongStreets(net, a, b);
    expect(Math.hypot(route[0].x - a.x, route[0].z - a.z)).toBeLessThan(1);
    const last = route[route.length - 1];
    expect(Math.hypot(last.x - b.x, last.z - b.z)).toBeLessThan(1);
  });

  it("returns fewer than 2 points when the two buildings share no street", () => {
    const layout = layoutWithTwoNamedBuildings();
    const net = deriveStreetNetwork(layout);
    const orphan = { fileId: "z", x: 9_999, z: 9_999, w: 4, d: 4, h: 1 };
    expect(routeAlongStreets(net, layout.buildings[0], orphan).length).toBeLessThan(2);
  });

  it("snaps a building onto the nearest street, not onto a sampled waypoint", () => {
    // The building at (20, 0) is 20u from the shared-edge street at x=0, which
    // has waypoints every 8u, so it sits between two of them and is 20.4u from
    // the closest waypoint. The ring's z=-17 street (spanning x[-57,57]) is
    // nearer still at 17u, and it is that one which serves the building.
    const layout: CityLayout = {
      ...twoBlocks,
      buildings: [
        { fileId: "near", x: -10, z: 0, w: 4, d: 4, h: 3 },
        { fileId: "far", x: 20, z: 0, w: 4, d: 4, h: 3 },
      ],
    };
    const net = deriveStreetNetwork(layout);
    const [near, far] = layout.buildings;
    const route = routeAlongStreets(net, near, far);
    expect(route.length).toBeGreaterThanOrEqual(2);
    expect(Math.hypot(route[0].x - near.x, route[0].z - near.z)).toBeLessThan(1);
    const last = route[route.length - 1];
    expect(Math.hypot(last.x - far.x, last.z - far.z)).toBeLessThan(1);
  });

  it("projects onto a street past its end, and gives up past the snap distance", () => {
    // Two 4u-deep blocks make a street only 4u long (z[-2,2]) and no ring at
    // all (the union is too shallow to inset), so the building at (0, 30) can
    // only be served by that street's END point, 28u away — well past the ~17u
    // the ring would have covered. The building at (0, 60) is 58u from the same
    // end: beyond MAX_SNAP_DISTANCE, so it gets no route at all.
    const layout: CityLayout = {
      repoPath: "/r",
      buildings: [
        { fileId: "near", x: -10, z: 0, w: 4, d: 4, h: 3 },
        { fileId: "pastEnd", x: 0, z: 30, w: 4, d: 4, h: 3 },
        { fileId: "wayPast", x: 0, z: 60, w: 4, d: 4, h: 3 },
      ],
      districts: [
        { path: "a", x: -15, z: 0, w: 30, d: 4, label: "a", depth: 0 },
        { path: "b", x: 15, z: 0, w: 30, d: 4, label: "b", depth: 0 },
      ],
      roads: [],
    };
    const net = deriveStreetNetwork(layout);
    const [near, pastEnd, wayPast] = layout.buildings;
    const route = routeAlongStreets(net, near, pastEnd);
    expect(route.length).toBeGreaterThanOrEqual(2);
    const last = route[route.length - 1];
    expect(Math.hypot(last.x - pastEnd.x, last.z - pastEnd.z)).toBeLessThan(1);
    expect(routeAlongStreets(net, near, wayPast).length).toBeLessThan(2);
  });

  it("routes identically with a prebuilt graph", () => {
    const layout = layoutWithTwoNamedBuildings();
    const net = deriveStreetNetwork(layout);
    const [a, b] = layout.buildings;
    expect(routeAlongStreets(net, a, b, buildStreetGraph(net))).toEqual(routeAlongStreets(net, a, b));
  });
});
