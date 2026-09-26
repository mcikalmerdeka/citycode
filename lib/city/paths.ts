/**
 * Path network — the pure, deterministic derivation of the walkable sidewalk
 * graph and the drivable road polylines from a {@link CityLayout}. This is
 * the Wave 1 simulation's substrate: agents walk `network.sidewalk`, vehicles
 * drive `network.roads`, and the renderer can reuse both for ground detail.
 *
 * ## Derivation rules (the contract the sim builds on)
 *
 * Everything below is a pure function of the layout — no Math.random, no
 * timestamps, no environment reads. Same layout in, byte-identical network
 * out.
 *
 * 1. **Sidewalk lattice per district.** Each district's rectangle is ringed
 *    by a sidewalk loop offset OUTSIDE the block edge by
 *    {@link SIDEWALK_OFFSET} (so pedestrians walk the pavement strip between
 *    a district's curb and the road, never inside the block). The loop is
 *    sampled at {@link SIDEWALK_STEP} intervals along each edge, plus the
 *    four corners — so long edges get evenly spaced nodes and short edges
 *    still get their corners.
 * 2. **Road-side sidewalks.** Every layout road polyline is duplicated on
 *    both sides, offset perpendicular by {@link SIDEWALK_OFFSET} +
 *    {@link ROAD_HALF_WIDTH} (the road's half width plus a pavement gap), and
 *    sampled at the same step. This is what makes roads walkable on both
 *    sides, matching the Small World reference where pedestrians line every
 *    street.
 * 3. **Cross-connections.** At every district corner the four loop corners
 *    are joined to their nearest road-side nodes (deterministic nearest by
 *    (distance, id) tie-break), and adjacent sampled nodes along a loop or a
 *    road side are chained — so the lattice is locally dense at corners and
 *    along streets.
 * 4. **Connectivity is a hard guarantee.** After derivation, the graph is
 *    checked with union-find; any extra components are joined by connecting
 *    each orphan component's nearest node pair to the main component
 *    (deterministic nearest-pair search), so the result is always ONE
 *    connected component.
 * 5. **Node ids** are `sw-{roundX}-{roundZ}` where roundX/roundZ are the
 *    coordinates rounded to 2 decimals — stable, unique per position, and
 *    readable in the sim's debug output.
 * 6. **Roads** mirror the layout's road polylines 1:1 (same waypoints, same
 *    order) with a constant {@link ROAD_WIDTH} (~6 world units, matching the
 *    visual road width). Road ids are `rd-{fromId}→{toId}` — stable and
 *    unique per edge.
 *
 * ## Guarantees
 *
 * - **Determinism**: identical layout → deep-equal network (tested).
 * - **Connectivity**: the sidewalk graph is always a single component
 *   (tested with union-find) — or empty when the layout has no geometry.
 * - **Sanity**: no zero-length segments, no duplicate segments (undirected),
 *   no duplicate node ids, and no node inside a building footprint (nodes
 *   are offset outside district edges and road centerlines; buildings sit
 *   inside districts with padding, so the offset clears them — tested).
 */

import type { Building, CityLayout, District } from "./layout";
import type { PathNetwork, RoadPolyline, SidewalkNetwork } from "../sim/types";

/** Sidewalk offset outside a district edge / road centerline (world units). */
const SIDEWALK_OFFSET = 2.5;
/** Sampling step along a district edge or road side (world units). */
const SIDEWALK_STEP = 6;
/** Road half width — roads are ~6 units wide, so the centerline clears 3. */
const ROAD_HALF = 3;
/** Extra pavement gap between the road edge and the road-side sidewalk. */
const PAVEMENT_GAP = 1.5;
/** Constant road width for every RoadPolyline (sim metadata; the visual
 * ribbon in Roads.tsx is narrower — this width keeps agents' lane offsets
 * comfortably inside the street). */
export const ROAD_WIDTH = 6;

/** A point on the XZ ground plane. */
interface Pt {
  x: number;
  z: number;
}

/** Round to 2 decimals for stable node ids (avoids float dust in ids). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Node id for a position — deterministic, unique per rounded position. */
function nodeIdFor(point: Pt): string {
  return `sw-${round2(point.x)}-${round2(point.z)}`;
}

/**
 * Sample one edge of a district ring (or one side of a road) into points:
 * the two endpoints plus evenly spaced interior points at ~SIDEWALK_STEP.
 * The last segment absorbs rounding drift so the endpoint is exact.
 */
function sampleEdge(from: Pt, to: Pt): Pt[] {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  if (length === 0) return [from];
  const count = Math.max(1, Math.round(length / SIDEWALK_STEP));
  const points: Pt[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
  }
  return points;
}

/**
 * The four corners of a district ring, offset OUTSIDE the block edge by
 * SIDEWALK_OFFSET. Order: NW, NE, SE, SW (deterministic).
 */
function districtRingCorners(district: District): Pt[] {
  const halfW = district.w / 2 + SIDEWALK_OFFSET;
  const halfD = district.d / 2 + SIDEWALK_OFFSET;
  return [
    { x: district.x - halfW, z: district.z - halfD },
    { x: district.x + halfW, z: district.z - halfD },
    { x: district.x + halfW, z: district.z + halfD },
    { x: district.x - halfW, z: district.z + halfD },
  ];
}

/** Chain consecutive points into segments (a→b, b→c, …). */
function chain(points: Pt[], addSegment: (a: Pt, b: Pt) => void): void {
  for (let i = 0; i < points.length - 1; i++) {
    addSegment(points[i], points[i + 1]);
  }
}

/**
 * Union-find over node ids — the connectivity oracle that guarantees the
 * sidewalk graph is one component.
 */
class UnionFind {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = this.parent.get(id) ?? id;
    while (root !== (this.parent.get(root) ?? root)) {
      root = this.parent.get(root) ?? root;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** Group node ids by component root. */
  components(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const group = groups.get(root);
      if (group === undefined) groups.set(root, [id]);
      else group.push(id);
    }
    return groups;
  }
}

/**
 * Derive the full path network (sidewalk graph + road polylines) from a
 * city layout. Pure and deterministic — see the module header for the
 * derivation rules the simulation consumes.
 */
export function derivePathNetwork(layout: CityLayout): PathNetwork {
  const nodes = new Map<string, Pt>();
  const segments: Array<{ a: string; b: string }> = [];
  const seenSegments = new Set<string>();

  const addNode = (point: Pt): string => {
    const id = nodeIdFor(point);
    if (!nodes.has(id)) nodes.set(id, point);
    return id;
  };

  const addSegment = (a: Pt, b: Pt): void => {
    const idA = addNode(a);
    const idB = addNode(b);
    if (idA === idB) return; // zero-length guard
    const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
    if (seenSegments.has(key)) return; // duplicate guard
    seenSegments.add(key);
    segments.push({ a: idA, b: idB });
  };

  // ---- 0. Fallback perimeter: with no districts and no roads there is
  // nothing to ring, so derive a single sidewalk loop around the bounding box
  // of all buildings (offset OUTSIDE the box, therefore outside every
  // footprint) — keeps the "buildings without districts" case connected.
  if (layout.districts.length === 0 && layout.buildings.length > 0) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const building of layout.buildings) {
      minX = Math.min(minX, building.x - building.w / 2);
      maxX = Math.max(maxX, building.x + building.w / 2);
      minZ = Math.min(minZ, building.z - building.d / 2);
      maxZ = Math.max(maxZ, building.z + building.d / 2);
    }
    const corners: Pt[] = [
      { x: minX - SIDEWALK_OFFSET, z: minZ - SIDEWALK_OFFSET },
      { x: maxX + SIDEWALK_OFFSET, z: minZ - SIDEWALK_OFFSET },
      { x: maxX + SIDEWALK_OFFSET, z: maxZ + SIDEWALK_OFFSET },
      { x: minX - SIDEWALK_OFFSET, z: maxZ + SIDEWALK_OFFSET },
    ];
    for (let i = 0; i < corners.length; i++) {
      chain(sampleEdge(corners[i], corners[(i + 1) % corners.length]), addSegment);
    }
  }

  // ---- 1. District sidewalk rings (offset outside each block edge).
  for (const district of layout.districts) {
    const corners = districtRingCorners(district);
    for (let i = 0; i < corners.length; i++) {
      const from = corners[i];
      const to = corners[(i + 1) % corners.length];
      chain(sampleEdge(from, to), addSegment);
    }
  }

  // ---- 2. Road-side sidewalks: duplicate each road polyline on both sides,
  // offset perpendicular by (road half width + pavement gap), sampled at the
  // same step. This is what makes every street walkable on both sides.
  const roadSideOffset = ROAD_HALF + PAVEMENT_GAP;
  for (const road of layout.roads) {
    for (const side of [-1, 1] as const) {
      const offsetPoints: Pt[] = [];
      for (let i = 0; i < road.points.length; i++) {
        const point = road.points[i];
        // Perpendicular direction from the previous/next waypoint (the road
        // is Manhattan-routed, so axis-aligned normals are exact).
        const prev = road.points[Math.max(0, i - 1)];
        const next = road.points[Math.min(road.points.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const length = Math.hypot(dx, dz);
        if (length === 0) {
          offsetPoints.push(point);
          continue;
        }
        // Perpendicular of (dx, dz) is (-dz, dx); normalize and scale.
        offsetPoints.push({
          x: point.x + (-dz / length) * roadSideOffset * side,
          z: point.z + (dx / length) * roadSideOffset * side,
        });
      }
      // Sample ALONG the offset polyline (not just the chord): each
      // consecutive waypoint pair becomes an edge, so the sidewalk follows
      // the Manhattan L-route around corners instead of cutting straight
      // lines through the block.
      for (let i = 0; i < offsetPoints.length - 1; i++) {
        chain(sampleEdge(offsetPoints[i], offsetPoints[i + 1]), addSegment);
      }
    }
  }

  // ---- 3. Cross-connections at district corners: join each ring corner to
  // the nearest road-side node (deterministic nearest by distance, then id).
  const allNodeIds = Array.from(nodes.keys());
  const nodeById = new Map(allNodeIds.map((id) => [id, nodes.get(id) as Pt]));
  for (const district of layout.districts) {
    for (const corner of districtRingCorners(district)) {
      const cornerId = addNode(corner);
      let bestId: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const id of allNodeIds) {
        if (id === cornerId) continue;
        const point = nodeById.get(id);
        if (point === undefined) continue;
        const dist = Math.hypot(point.x - corner.x, point.z - corner.z);
        if (dist < bestDist || (dist === bestDist && id < (bestId ?? ""))) {
          bestDist = dist;
          bestId = id;
        }
      }
      if (bestId !== null && bestDist > 0 && bestDist <= SIDEWALK_STEP * 2) {
        addSegment(corner, nodeById.get(bestId) as Pt);
      }
    }
  }

  // ---- 3b. Footprint filter (BEFORE connectivity bridging): drop nodes
  // that sit strictly inside a building footprint, along with their segments.
  // Road-side sidewalks pass buildings closely, so this is a real filter —
  // and it must run before bridging so the bridge step sees the final graph.
  const footprints = layout.buildings.map((building) => ({
    minX: building.x - building.w / 2,
    maxX: building.x + building.w / 2,
    minZ: building.z - building.d / 2,
    maxZ: building.z + building.d / 2,
  }));
  const insideFootprint = (point: Pt): boolean => {
    for (const box of footprints) {
      if (point.x > box.minX && point.x < box.maxX && point.z > box.minZ && point.z < box.maxZ) {
        return true;
      }
    }
    return false;
  };
  for (const [id, point] of Array.from(nodes.entries())) {
    if (insideFootprint(point)) {
      nodes.delete(id);
    }
  }
  const liveSegments = segments.filter(
    (segment) => nodes.has(segment.a) && nodes.has(segment.b),
  );
  segments.length = 0;
  segments.push(...liveSegments);

  // ---- 4. Connectivity guarantee: union-find over the derived graph; any
  // extra components are bridged to the main component by their nearest
  // node pair (deterministic nearest-pair search).
  const uf = new UnionFind();
  for (const id of nodes.keys()) uf.add(id);
  for (const segment of segments) uf.union(segment.a, segment.b);
  const components = Array.from(uf.components().values());
  if (components.length > 1) {
    // Sort components deterministically (by first id) so the bridging order
    // is stable.
    components.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
    const rest = components.slice(1);
    for (const group of rest) {
      // Nearest pair between this component and ALL nodes so far (main +
      // previously bridged groups) — keeps the graph connected after each
      // bridge.
      let bestA: string | null = null;
      let bestB: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const idA of group) {
        const pointA = nodeById.get(idA);
        if (pointA === undefined) continue;
        for (const [idB, pointB] of nodes) {
          if (uf.find(idB) === uf.find(idA)) continue;
          const dist = Math.hypot(pointB.x - pointA.x, pointB.z - pointA.z);
          if (dist < bestDist || (dist === bestDist && idB < (bestB ?? ""))) {
            bestDist = dist;
            bestA = idA;
            bestB = idB;
          }
        }
      }
      if (bestA !== null && bestB !== null) {
        addSegment(nodeById.get(bestA) as Pt, nodeById.get(bestB) as Pt);
        uf.union(bestA, bestB);
      }
    }
  }

  // ---- Output contract: nodes sorted by id, segments in insertion order.
  const sidewalk: SidewalkNetwork = {
    nodes: Array.from(nodes.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, point]) => ({ id, x: point.x, z: point.z })),
    segments,
  };

  // ---- Roads: mirror the layout's polylines 1:1 with a constant width.
  const roads: RoadPolyline[] = layout.roads.map((road, index) => ({
    id: `rd-${road.fromId}→${road.toId}#${index}`,
    points: road.points.map((point) => ({ x: point.x, z: point.z })),
    width: ROAD_WIDTH,
  }));

  return { sidewalk, roads };
}

/** Unused import guard — Building is part of the documented public surface. */
export type { Building };
