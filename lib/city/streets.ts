/**
 * Street network — the pure, deterministic derivation of the drivable street
 * grid from a {@link CityLayout}'s district rectangles.
 *
 * The city already contains every piece of geometry a street grid needs.
 * `squarify` (lib/city/layout.ts) scales partition weights so its cells tile
 * their rectangle EXACTLY, so adjacent district blocks TOUCH — the gap
 * between them is zero, up to float dust. The only real gaps are the interior
 * rings between a parent district and the block its children partition, which
 * are `padding` wide per side. This module reads that geometry and turns it
 * into corridors, intersections and block insets. It is deliberately blind to
 * the import graph: `layout.roads` is data, not geometry, and a street grid
 * must exist whether or not a repo has intra-repo imports at all.
 *
 * ## Derivation rules (the contract components/city/ renders from)
 *
 * 1. **Every shared edge is a street.** For each ordered pair of district rects
 *    that overlap along one axis, the separation along the other axis is the
 *    street's width (floored at {@link STREET_WIDTH}) and the shared span is
 *    its extent. A zero gap — the touching case every squarified cell makes —
 *    still yields a full-width road straddling the boundary, so each block
 *    only has to pull back half of it. Overlapping and nested rects (a parent
 *    and its own child) have no shared edge and produce nothing; a parent's
 *    interior ring shows up instead as the gap between one of its children and
 *    whatever lies across from it.
 * 2. **A gap is a street only up to {@link MAX_STREET_WIDTH}.** Anything wider
 *    is a plaza between two neighbourhoods, not a road, and is skipped.
 * 3. **Duplicate candidates merge.** Both orders of every pair describe the
 *    same centreline, and three blocks around one corner produce it twice;
 *    candidates sharing an axis and a centreline (within
 *    {@link MERGE_TOLERANCE}) collapse into one corridor with the widest width
 *    and the union of their spans. A shared edge and the parent ring beside it
 *    are the same street seen from two nesting levels, not two streets.
 * 4. **Parallel streets split the space between them.** After the merge, a
 *    corridor is narrowed to the distance to its nearest same-axis neighbour
 *    whose span overlaps its own. Widths are measured from a street's own
 *    centreline, so each street claiming "its half" of the gap means exactly
 *    touching tarmac, never overlapping — for any pair, not just neighbours.
 * 5. **Every city is ringed.** Four corridors inset by half a street from the
 *    union of its blocks give every layout a boundary road — a single-block
 *    city, a district-less one and a twenty-district one alike. The ring goes
 *    through the same merge as the interior streets, so a ring edge that lands
 *    on an existing street folds into it instead of doubling up.
 * 6. **Intersections** are every crossing of an "x" corridor with a "z"
 *    corridor — each one's centre falling inside the other's span.
 * 7. **Block insets** tell the renderer how far to pull each block back, per
 *    side, so a rendered block never overlaps tarmac. Derived in ONE pass from
 *    the final corridors (see lib/city/blockInsets.ts), so no inset is ever
 *    written from a width a later step has already changed.
 * 8. **Never through a wall.** A corridor that would run more than a unit into
 *    a building's footprint narrows back to {@link STREET_WIDTH} — never wider
 *    than it already was. That repair is the last thing to touch a corridor,
 *    and the insets are derived after it.
 *
 * ## Module layout
 *
 * This module owns the street GEOMETRY and the public surface. Two jobs live
 * beside it, split along their own seams:
 *
 * - `lib/city/blockInsets.ts` — the block pull-back map and the footprint
 *   repair, i.e. everything that reads corridor widths to place a block.
 * - `lib/city/streetGraph.ts` — the routing graph, snap and BFS behind
 *   {@link routeAlongStreets}. Exported so a renderer can build the graph once
 *   per city and pass it in.
 *
 * ## Guarantees
 *
 * - **Pure, deterministic, non-mutating**: no `Math.random`, no `Date.now`,
 *   no environment reads, plain `<` comparisons only. Reads `layout.districts`
 *   and `layout.buildings` and nothing else — never `layout.roads` — and never
 *   mutates the layout. Same layout in, deep-equal network out, whatever order
 *   the input arrays are in (rects and districts are re-sorted by path).
 * - **No NaN**: an empty layout, a district-less layout and a one-block layout
 *   all return a well-formed network.
 * - **Corridors never overlap.** No two same-axis corridors sit within
 *   {@link MERGE_TOLERANCE} of each other (that would be one street), and no two
 *   same-axis corridors whose spans overlap have tarmac that overlaps — so the
 *   renderer never draws one ribbon on top of another.
 * - **Blocks stay clear of tarmac**: every inset comes from the final corridor
 *   widths, so it is never smaller than the widest street touching that side.
 */

import type { Building, CityLayout } from "./layout";
import { deriveBlockInsets, narrowCorridorsAgainstFootprints } from "./blockInsets";
import {
  breadthFirst,
  buildStreetGraph,
  nearestCorridorNode,
  type StreetGraph,
} from "./streetGraph";

/**
 * Waypoint spacing along a corridor centreline, and the furthest a building may
 * sit from a street and still be served by it. Both belong to the routing
 * graph, and are re-exported here so the street module stays the single import
 * surface for the renderer and the simulation.
 */
export { MAX_SNAP_DISTANCE, STREET_NODE_STEP } from "./streetGraph";

/** Tarmac width of the narrowest street (world units). */
export const STREET_WIDTH: number = 6;
/** Kerb thickness drawn at each pavement edge (world units). */
export const KERB_WIDTH: number = 0.6;
/** Pavement width on each side of a street (world units). */
export const PAVEMENT_WIDTH: number = 2.4;
/** Widest gap still promoted to a street; wider gaps stay plazas (world units). */
export const MAX_STREET_WIDTH: number = 14;
/** Ground height the pavement sits at, above the tarmac (world units). */
export const PAVEMENT_Y: number = 0.2;

/**
 * Float tolerance for "the same" coordinate. `squarify` accumulates doubles, so
 * a shared edge is usually `7.999999999` rather than `8`; every comparison
 * that means "touching" is made against this epsilon.
 */
const EDGE_EPSILON = 1e-6;

/**
 * Same-axis corridors closer than this are the SAME street seen from two
 * nesting levels, not two streets — a shared edge and the parent ring beside it
 * describe one road, and a renderer that drew both would show one street twice.
 *
 * Half a street is a VISUAL IDENTITY threshold, not a geometric guarantee:
 * distinct streets in this treemap really do land 3-5u apart (each nesting
 * level's padding ring is wider than the one inside it). Two consequences, and
 * they are separate: this tolerance decides which centrelines are *one street*,
 * and the shared-space width clamp — not this merge — is what guarantees that no
 * two surviving streets share tarmac.
 */
const MERGE_TOLERANCE: number = STREET_WIDTH / 2;

/** Path of the synthetic block used when a layout has no districts. */
const SYNTHETIC_PATH = "";

/** One axis-aligned street: a strip of tarmac along `axis`, centred on `center`. */
export interface StreetCorridor {
  /** Axis: "x" = runs along Z (a north–south street), "z" = runs along X. */
  axis: "x" | "z";
  /** Centreline coordinate on the perpendicular axis. */
  center: number;
  /**
   * Full tarmac width. The gap rule floors it at {@link STREET_WIDTH}; the
   * shared-space clamp then narrows a street to the distance to its nearest
   * parallel neighbour, so a consumer must NOT assume `width >= STREET_WIDTH` —
   * the narrowest a street ever gets is half a street.
   */
  width: number;
  /** Centreline extent along its own axis: [min, max]. */
  from: number;
  to: number;
}

/** A point where two corridors cross. */
export interface StreetIntersection {
  x: number;
  z: number;
  /**
   * Axis of the north–south corridor of the crossing — the scan finds every
   * crossing from an "x" corridor, so this is always "x".
   */
  axis: "x" | "z";
}

/** The derived street grid a renderer and the simulation both read. */
export interface StreetNetwork {
  corridors: StreetCorridor[];
  intersections: StreetIntersection[];
  /** How far each district's rendered block must pull back, per side. */
  blockInsets: Map<string, { x: number; z: number; top: number; bottom: number }>;
}

/** A district block as a min/max rectangle. */
interface BlockRect {
  path: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the street network (corridors + intersections + block insets) from a
 * city layout. Pure and deterministic — see the module header for the
 * derivation rules and the guarantees the renderer depends on.
 *
 * The last two steps are order-dependent on purpose: the footprint repair
 * narrows corridors, and the block pull-backs are derived from the widths that
 * survive it. Deriving them earlier and patching afterwards is what put a block
 * edge back inside a street's tarmac.
 */
export function deriveStreetNetwork(layout: CityLayout): StreetNetwork {
  const rects = blockRects(layout);
  const candidates: StreetCorridor[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      pushSeparator(candidates, rects[i], rects[j], "x");
      pushSeparator(candidates, rects[i], rects[j], "z");
    }
  }
  // ---- Perimeter ring: every city gets a boundary road, inset half a street
  // inside the union of its blocks. It joins the SAME candidate pool as the
  // interior streets so the merge below folds a ring edge that lands on an
  // existing street into that street instead of emitting a second ribbon.
  appendPerimeterRing(candidates, rects);

  const corridors = mergeCorridors(candidates);
  // ---- Shared space: once identity is settled, every street narrows to what
  // it can claim without covering a parallel neighbour.
  clampWidthsToParallelNeighbours(corridors);

  const intersections = findIntersections(corridors);
  // ---- Order matters from here on: the footprint repair narrows corridors,
  // and only then is the block pull-back derived, so an inset is never written
  // from a width that no longer exists (see lib/city/blockInsets.ts).
  narrowCorridorsAgainstFootprints(corridors, layout.buildings, STREET_WIDTH);
  const blockInsets = deriveBlockInsets(layout.districts, corridors);

  // ---- Output contract: sorted arrays, plain `<` comparisons only.
  corridors.sort(
    (a, b) => (a.axis !== b.axis ? compareStrings(a.axis, b.axis) : a.center !== b.center ? a.center - b.center : a.from - b.from),
  );
  intersections.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.z - b.z));
  return { corridors, intersections, blockInsets };
}

/**
 * Shortest polyline along corridor centrelines from one building to another.
 * Returns fewer than 2 points when the two are not connected by the street
 * graph. Used only by the Roads import-route overlay.
 *
 * Pass `graph` (from {@link buildStreetGraph}) when routing many edges for one
 * city: the graph is then built once instead of once per edge. Omit it and the
 * graph is built here, which is what a one-off call wants.
 *
 * Deterministic: ties on "nearest street" resolve to the first corridor in
 * sorted order, and BFS explores neighbours in insertion order.
 */
export function routeAlongStreets(
  streets: StreetNetwork,
  from: Building,
  to: Building,
  graph?: StreetGraph,
): Array<{ x: number; z: number }> {
  if (streets.corridors.length === 0) {
    return [];
  }
  const waypoints = graph ?? buildStreetGraph(streets);
  const start = nearestCorridorNode(waypoints, streets.corridors, from.x, from.z);
  const end = nearestCorridorNode(waypoints, streets.corridors, to.x, to.z);
  if (start < 0 || end < 0) {
    return [];
  }
  const path = breadthFirst(waypoints.adj, start, end);
  if (path.length === 0) {
    return [];
  }
  // The polyline runs building centre → snapped street nodes → building
  // centre, so it visibly starts and ends at the two files it connects.
  const points: Array<{ x: number; z: number }> = [{ x: from.x, z: from.z }];
  for (const index of path) {
    const point = waypoints.nodes[index];
    const previous = points[points.length - 1];
    if (point === undefined || previous === undefined) continue;
    // Skip a node that coincides with the point before it — a zero-length
    // segment renders as nothing and would only confuse the ribbon builder.
    if (Math.abs(point.x - previous.x) > EDGE_EPSILON || Math.abs(point.z - previous.z) > EDGE_EPSILON) {
      points.push({ x: point.x, z: point.z });
    }
  }
  const last = points[points.length - 1];
  if (last === undefined || Math.abs(last.x - to.x) > EDGE_EPSILON || Math.abs(last.z - to.z) > EDGE_EPSILON) {
    points.push({ x: to.x, z: to.z });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Geometry: rects, corridors, intersections
// ---------------------------------------------------------------------------

/**
 * The layout's blocks as min/max rects, sorted by path so input order can
 * never leak into the output. A layout with no districts (a repo with no
 * folders) synthesizes one rect from the building bounds, grown by
 * {@link STREET_WIDTH} so the perimeter ring runs clear of the outermost
 * footprints instead of slicing them.
 */
function blockRects(layout: CityLayout): BlockRect[] {
  const rects: BlockRect[] = [];
  for (const district of layout.districts) {
    rects.push({
      path: district.path,
      minX: district.x - district.w / 2,
      maxX: district.x + district.w / 2,
      minZ: district.z - district.d / 2,
      maxZ: district.z + district.d / 2,
    });
  }
  rects.sort((a, b) => compareStrings(a.path, b.path));
  if (rects.length > 0 || layout.buildings.length === 0) {
    return rects;
  }
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
  rects.push({
    path: SYNTHETIC_PATH,
    minX: minX - STREET_WIDTH,
    maxX: maxX + STREET_WIDTH,
    minZ: minZ - STREET_WIDTH,
    maxZ: maxZ + STREET_WIDTH,
  });
  return rects;
}

/**
 * Push the street candidate that separates `a` from `b` along `axis`, if the
 * two rects share a span on the other axis and the gap between them is street
 * sized. An "x" corridor runs along Z, so the shared span is the Z overlap and
 * the gap is the X separation; "z" is the same with the axes swapped.
 */
function pushSeparator(
  out: StreetCorridor[],
  a: BlockRect,
  b: BlockRect,
  axis: "x" | "z",
): void {
  const from = axis === "x" ? Math.max(a.minZ, b.minZ) : Math.max(a.minX, b.minX);
  const to = axis === "x" ? Math.min(a.maxZ, b.maxZ) : Math.min(a.maxX, b.maxX);
  if (!(to > from)) {
    return; // no shared span: the rects are side by side, not across a street
  }
  // The two facing-edge pairs on the perpendicular axis: is b past a's high
  // edge, or is a past b's high edge? Both are separations, and the larger one
  // is the gap.
  const aLow = axis === "x" ? a.minX : a.minZ;
  const aHigh = axis === "x" ? a.maxX : a.maxZ;
  const bLow = axis === "x" ? b.minX : b.minZ;
  const bHigh = axis === "x" ? b.maxX : b.maxZ;
  const bPastA = bLow - aHigh;
  const aPastB = aLow - bHigh;
  let gap = Math.max(bPastA, aPastB);
  if (Math.abs(gap) <= EDGE_EPSILON) {
    gap = 0; // squarify's float dust: touching, not separated
  }
  if (gap < 0 || gap > MAX_STREET_WIDTH) {
    return; // overlapping or nested rects share no edge, and a plaza is no street
  }
  // The centreline sits on the shared edge when the rects touch and in the
  // middle of the gap when they are separated. Which facing pair that is comes
  // from the smaller-magnitude separation, so a shared edge that arrived as
  // `-51.89999999999999` against `-51.90000000000001` still resolves to that
  // edge instead of to the far side of one of the rects.
  const bOnTheHighSide = gap === 0 ? Math.abs(bPastA) <= Math.abs(aPastB) : bPastA > aPastB;
  const center = bOnTheHighSide ? (aHigh + bLow) / 2 : (aLow + bHigh) / 2;
  out.push({ axis, center, width: Math.max(gap, STREET_WIDTH), from, to });
}

/**
 * Collapse candidates that describe the same centreline: same axis, centres
 * within {@link MERGE_TOLERANCE}. The group's width is the widest and its extent
 * the union, so a street shared by three blocks is one street.
 */
function mergeCorridors(candidates: StreetCorridor[]): StreetCorridor[] {
  const sorted = candidates.slice().sort(
    (a, b) => (a.axis !== b.axis ? compareStrings(a.axis, b.axis) : a.center !== b.center ? a.center - b.center : a.from - b.from),
  );
  const merged: StreetCorridor[] = [];
  for (const candidate of sorted) {
    const previous = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (previous !== undefined && previous.axis === candidate.axis && Math.abs(candidate.center - previous.center) <= MERGE_TOLERANCE) {
      // `previous.center` is never rewritten, so grouping anchors on the first
      // candidate of the run instead of drifting along it.
      previous.width = Math.max(previous.width, candidate.width);
      previous.from = Math.min(previous.from, candidate.from);
      previous.to = Math.max(previous.to, candidate.to);
      continue;
    }
    merged.push({ ...candidate });
  }
  return merged;
}

/**
 * Narrow every corridor to the distance to its nearest SAME-AXIS neighbour whose
 * span overlaps its own, so no two parallel streets claim the same tarmac.
 *
 * The space between two parallel centrelines belongs to both of them, and each
 * may take at most its half of it. A width is measured from a street's own
 * centreline, so "its half of the gap" IS the full centre-to-centre distance:
 * two streets of equal width then satisfy `w/2 + w/2 = d` and their tarmacs
 * exactly touch instead of overlapping. Because every corridor is capped at its
 * own nearest-neighbour distance, the pair invariant `w_i/2 + w_j/2 <= d_ij`
 * holds for every pair, not just adjacent ones.
 *
 * Same-axis only — an "x" and a "z" corridor cross at a right angle and share no
 * space. Span overlap only — two parallel streets on opposite sides of the city
 * never touch. Limits are read from centre positions, never from a neighbour's
 * already-clamped width, so the outcome does not depend on visit order. The
 * floor is structural rather than tuned: {@link mergeCorridors} keeps same-axis
 * centres more than {@link MERGE_TOLERANCE} apart, so the tightest cap this can
 * produce is half a street.
 */
function clampWidthsToParallelNeighbours(corridors: StreetCorridor[]): void {
  for (let i = 0; i < corridors.length; i++) {
    const corridor = corridors[i];
    let limit = Number.POSITIVE_INFINITY;
    for (let j = 0; j < corridors.length; j++) {
      if (i === j) continue;
      const neighbour = corridors[j];
      if (neighbour.axis !== corridor.axis) continue;
      if (!(Math.min(corridor.to, neighbour.to) - Math.max(corridor.from, neighbour.from) > 0)) {
        continue; // parallel but side by side in span: no shared space
      }
      limit = Math.min(limit, Math.abs(neighbour.center - corridor.center));
    }
    if (limit < corridor.width) {
      corridor.width = limit;
    }
  }
}

/**
 * Ring the union of every block with four corridors inset by half a street, so
 * the outermost tarmac sits flush with the city edge. Skipped when the union
 * is degenerate: a zero-extent ring would be a set of zero-length corridors.
 */
function appendPerimeterRing(out: StreetCorridor[], rects: BlockRect[]): void {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.minX);
    maxX = Math.max(maxX, rect.maxX);
    minZ = Math.min(minZ, rect.minZ);
    maxZ = Math.max(maxZ, rect.maxZ);
  }
  const inset = STREET_WIDTH / 2;
  const loX = minX + inset;
  const hiX = maxX - inset;
  const loZ = minZ + inset;
  const hiZ = maxZ - inset;
  if (!(loX < hiX) || !(loZ < hiZ)) {
    return;
  }
  out.push(
    { axis: "x", center: loX, width: STREET_WIDTH, from: loZ, to: hiZ },
    { axis: "x", center: hiX, width: STREET_WIDTH, from: loZ, to: hiZ },
    { axis: "z", center: loZ, width: STREET_WIDTH, from: loX, to: hiX },
    { axis: "z", center: hiZ, width: STREET_WIDTH, from: loX, to: hiX },
  );
}

/** Every place an "x" corridor crosses a "z" corridor. */
function findIntersections(corridors: StreetCorridor[]): StreetIntersection[] {
  const intersections: StreetIntersection[] = [];
  for (const northSouth of corridors) {
    if (northSouth.axis !== "x") continue;
    for (const eastWest of corridors) {
      if (eastWest.axis !== "z") continue;
      if (
        eastWest.center >= northSouth.from &&
        eastWest.center <= northSouth.to &&
        northSouth.center >= eastWest.from &&
        northSouth.center <= eastWest.to
      ) {
        intersections.push({ x: northSouth.center, z: eastWest.center, axis: "x" });
      }
    }
  }
  return intersections;
}

/** Plain `<`/`>` comparison — localeCompare is banned (locale-dependent). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
