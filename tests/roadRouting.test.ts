import { describe, expect, it } from "vitest";
import { routeRoad } from "@/lib/city/layout";
import type { Building } from "@/lib/city/layout";

// ---------------------------------------------------------------------------
// routeRoad — the render-time Manhattan routing helper. Pure and
// deterministic: same two buildings in, byte-identical waypoints out.
// ---------------------------------------------------------------------------

function building(fileId: string, x: number, z: number, w = 4, d = 4): Building {
  return { fileId, x, z, w, d, h: 3 };
}

describe("routeRoad", () => {
  it("is deterministic — identical inputs yield identical waypoints", () => {
    const a = building("src/a.ts", 0, 0);
    const b = building("src/b.ts", 20, 12);
    expect(routeRoad(a, b)).toEqual(routeRoad(a, b));
  });

  it("routes axis-aligned buildings as a straight 2-point line", () => {
    const a = building("src/a.ts", 0, 0);
    const b = building("src/b.ts", 20, 0);
    const points = routeRoad(a, b);
    expect(points).toHaveLength(2);
    expect(points[0].z).toBe(0);
    expect(points[1].z).toBe(0);
  });

  it("routes diagonal buildings through a single 90° corner", () => {
    const a = building("src/a.ts", 0, 0);
    const b = building("src/b.ts", 20, 12);
    const points = routeRoad(a, b);
    expect(points).toHaveLength(3);
    const corner = points[1];
    // Manhattan corner: shares one axis with each endpoint.
    const xThenZ = corner.x === 20 && corner.z === 0;
    const zThenX = corner.x === 0 && corner.z === 12;
    expect(xThenZ || zThenX).toBe(true);
  });

  it("trims endpoints out of the building footprints", () => {
    const a = building("src/a.ts", 0, 0, 4, 4);
    const b = building("src/b.ts", 30, 0, 6, 6);
    const points = routeRoad(a, b);
    // First point must be outside a's footprint (w/2 = 2 along X).
    expect(points[0].x).toBeGreaterThanOrEqual(2);
    // Last point must be outside b's footprint (w/2 = 3 along X).
    expect(points[points.length - 1].x).toBeLessThanOrEqual(30 - 3);
  });

  it("keeps both endpoints on the straight segment for axis-aligned pairs", () => {
    const a = building("src/a.ts", 0, 0, 4, 4);
    const b = building("src/b.ts", 30, 0, 6, 6);
    const [start, end] = routeRoad(a, b);
    expect(start).toEqual({ x: 2.5, z: 0 }); // 2 (half w) + 0.5 (gap)
    expect(end).toEqual({ x: 26.5, z: 0 }); // 30 - 3 (half w) - 0.5 (gap)
  });

  it("never returns fewer than 2 points, even for coincident centers", () => {
    const a = building("src/a.ts", 5, 5);
    const b = building("src/b.ts", 5, 5);
    const points = routeRoad(a, b);
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flip endpoints when a segment is shorter than the trim", () => {
    // Centers 2 apart but the trim wants 2.5 — the route must stay ordered.
    const a = building("src/a.ts", 0, 0, 4, 4);
    const b = building("src/b.ts", 2, 0, 4, 4);
    const [start, end] = routeRoad(a, b);
    expect(start.x).toBeLessThanOrEqual(end.x);
  });
});
