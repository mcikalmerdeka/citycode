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
 * 2. **Street-side sidewalks.** Every street corridor from
 *    {@link deriveStreetNetwork} is duplicated on both sides, offset
 *    perpendicular to its centreline by half the tarmac plus kerb plus half
 *    the pavement — the middle of the pavement strip — and sampled at the
 *    same step. This is what makes streets walkable on both sides, matching
 *    the Small World reference where pedestrians line every street.
 * 3. **Cross-connections.** At every district corner the four loop corners
 *    are joined to their nearest street-side nodes (deterministic nearest by
 *    (distance, id) tie-break), and adjacent sampled nodes along a loop or a
 *    street side are chained — so the lattice is locally dense at corners and
 *    along streets.
 * 4. **Connectivity is a hard guarantee.** After derivation, the graph is
 *    checked with union-find; any extra components are joined by connecting
 *    each orphan component's nearest node pair to the main component
 *    (deterministic nearest-pair search), so the result is always ONE
 *    connected component.
 * 5. **Node ids** are `sw-{roundX}-{roundZ}` where roundX/roundZ are the
 *    coordinates rounded to 2 decimals — stable, unique per position, and
 *    readable in the sim's debug output.
 * 6. **Roads** are the street corridors from {@link deriveStreetNetwork} —
 *    centreline polylines sampled at {@link STREET_NODE_STEP} plus every
 *    intersection lying on the corridor, so crossing streets share a node
 *    and the sim's road graph welds at junctions. The layout's import edges
 *    are never drivable. Road ids are `st-{axis}-{center}-{from}-{to}` —
 *    stable and unique per corridor.
 *
 * ## Guarantees
 *
 * - **Determinism**: identical layout → deep-equal network (tested).
 * - **Connectivity**: the sidewalk graph is always a single component
 *   (tested with union-find) — or empty when the layout has no geometry.
 * - **Sanity**: no zero-length segments, no duplicate segments (undirected),
 *   no duplicate node ids, and no node inside a building footprint (nodes
 *   are offset outside district edges and street centrelines; buildings sit
 *   inside districts with padding, so the offset clears them — tested).
 */

import type { Building, CityLayout, District } from "./layout";
import type { PathNetwork, RoadPolyline, SidewalkNetwork } from "../sim/types";
import {
  deriveStreetNetwork,
  KERB_WIDTH,
  PAVEMENT_WIDTH,
  STREET_NODE_STEP,
  STREET_WIDTH,
  type StreetCorridor,
  type StreetIntersection,
} from "./streets";

/** Sidewalk offset outside a district edge / road centerline (world units). */
const SIDEWALK_OFFSET = 2.5;
/** Sampling step along a district edge or road side (world units). */
const SIDEWALK_STEP = 6;

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
    // Two-pass find with FULL path compression: walk to the root collecting
    // the path, then point every visited node straight at the root. Without
    // compression the bridge step's O(orphan x nodes) scan multiplies by the
    // chain depth and dominates the whole derivation (~1.3s on the fixture).
    const path: string[] = [];
    let node = id;
    let root = this.parent.get(node) ?? node;
    while (root !== (this.parent.get(root) ?? root)) {
      path.push(node);
      node = root;
      root = this.parent.get(root) ?? root;
    }
    for (const visited of path) this.parent.set(visited, root);
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
  // The street network is derived ONCE and shared by the sidewalk step and
  // the road output below — corridors are the geometry both derive from.
  const street = deriveStreetNetwork(layout);
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

  // ---- 2. Street-side sidewalks: duplicate each corridor centreline on both
  // sides, offset perpendicular by (half tarmac + kerb + half pavement) — the
  // middle of the pavement strip. This is what makes every street walkable on
  // both sides. Corridors are axis-aligned, so the normals are exact.
  const pavementOffset = STREET_WIDTH / 2 + KERB_WIDTH + PAVEMENT_WIDTH / 2;
  for (const corridor of street.corridors) {
    for (const side of [-1, 1] as const) {
      // One 2-point chain along the pavement side; sampleEdge spaces the
      // interior nodes, exactly as the old road sides did.
      const from = offsetPoint(corridor, corridor.from, side, pavementOffset);
      const to = offsetPoint(corridor, corridor.to, side, pavementOffset);
      chain(sampleEdge(from, to), addSegment);
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
  // Street-side sidewalks pass buildings closely, so this is a real filter —
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
    // is stable. Plain codepoint comparison — localeCompare is banned
    // (locale-dependent; the global constraint applies to this module too).
    components.sort((a, b) => {
      const idA = a[0] ?? "";
      const idB = b[0] ?? "";
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });
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
        const rootA = uf.find(idA); // loop-invariant: computed once per idA
        for (const [idB, pointB] of nodes) {
          if (uf.find(idB) === rootA) continue;
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

  // ---- Roads: the street corridors, sampled for the sim's road graph.
  const roads: RoadPolyline[] = street.corridors.map((corridor) => ({
    id: `st-${corridor.axis}-${round2(corridor.center)}-${round2(corridor.from)}-${round2(corridor.to)}`,
    points: sampleCorridor(corridor, street.intersections, STREET_NODE_STEP),
    width: STREET_WIDTH,
  }));

  return { sidewalk, roads };
}

/** One point on the pavement-middle offset line of a corridor, for endpoint
 * `along` on side `side`. Corridors are axis-aligned, so the normal is exact. */
function offsetPoint(corridor: StreetCorridor, along: number, side: -1 | 1, distance: number): Pt {
  const x =
    corridor.axis === "x"
      ? corridor.center + side * distance
      : along;
  const z =
    corridor.axis === "x"
      ? along
      : corridor.center + side * distance;
  return { x, z };
}

/**
 * Sample one corridor's centreline for the sim's road graph: points every
 * `step` along [from, to] (both endpoints always included), plus every
 * intersection lying on the corridor — the same construction
 * `buildStreetGraph` uses, so crossing corridors share exact coordinates and
 * the vehicle graph welds at junctions instead of fragmenting into
 * per-corridor chains.
 */
function sampleCorridor(
  corridor: StreetCorridor,
  intersections: StreetIntersection[],
  step: number,
): Pt[] {
  const span = corridor.to - corridor.from;
  const count = Math.max(1, Math.ceil(span / step));
  const positions: number[] = [];
  for (let i = 0; i <= count; i++) {
    positions.push(corridor.from + (span * i) / count);
  }
  for (const intersection of intersections) {
    const across = corridor.axis === "x" ? intersection.x : intersection.z;
    const along = corridor.axis === "x" ? intersection.z : intersection.x;
    if (Math.abs(across - corridor.center) > 1e-6) continue;
    if (along < corridor.from - 1e-6 || along > corridor.to + 1e-6) continue;
    positions.push(along);
  }
  positions.sort((a, b) => a - b);
  return positions.map((along) =>
    corridor.axis === "x"
      ? { x: corridor.center, z: along }
      : { x: along, z: corridor.center },
  );
}

/** Unused import guard — Building is part of the documented public surface. */
export type { Building };
