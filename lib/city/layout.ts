/**
 * City layout — the deterministic mapping from a {@link CodeGraph} to a 3D
 * city scene: files become buildings inside folder-district blocks, imports
 * become ground-level roads.
 *
 * This is the coupling point between the layout engine and the renderer:
 * `computeCityLayout` (pure function) produces this shape; `components/city/`
 * consumes it verbatim with no re-derivation. Phase 4/5 compare modes render
 * on this same layout — classification must never trigger re-layout — and
 * Phase 6 persists it inside snapshots, so:
 *
 * 1. **Determinism is a hard requirement.** Identical graph input MUST yield
 *    identical output (sorted arrays, fixed key order, no randomness, no
 *    timestamps). Same repo twice → pixel-identical render.
 * 2. **Position encodes folder structure only.** Never importance, never
 *    compare status (PRD §10: one visual property, one meaning).
 *
 * ## Algorithm (fixed choices — the renderer must never second-guess these)
 *
 * - **Squarified treemap** (Bruls, Huizing & van Wijk, 2000) — chosen over
 *   slice-and-dice because it bounds cell aspect ratios (~≤3 in practice),
 *   keeping district blocks readable at any repo shape, while being exactly
 *   as deterministic: partition items are totally ordered by (area desc,
 *   key asc) before any rectangle is cut, so input array order can never
 *   leak into geometry.
 * - **Root rectangle**: W = √(totalArea·4/3), D = √(totalArea·3/4) — a fixed
 *   4:3 landscape ratio with W·D = totalArea exactly, centered on the origin.
 * - **Areas, bottom-up**: building area = max(minFootprint, loc·(totalArea /
 *   totalLoc)) — footprint area ∝ LOC, summing to totalArea across the repo.
 *   A district's partition weight is (2·pad + √content)²: the exact weight a
 *   *square* block needs so that after insetting its own padding exactly its
 *   children's content weight remains (squarified cells are near-square, so
 *   the approximation is tight). A district's padding is
 *   districtPadding·(1 + 0.5·depth) — deeper blocks get thicker framing so
 *   nesting stays readable — capped at a quarter of each block dimension so
 *   tiny blocks always keep positive room for content.
 * - **Building footprints**: aspect = √(max(1, functionCount)),
 *   w = √(area·aspect), d = √(area/aspect) — a visible nod to symbol count
 *   that preserves w·d = area (area∝LOC untouched). The footprint is then
 *   clamped into the building's allocated cell: containment of a block
 *   outranks the symbol-count nod.
 * - **Heights**: h = max(0.5, loc·heightPerLoc) — the 0.5 floor keeps
 *   1-line files clickable.
 */

import type { CodeGraph, FileNode } from "../types";

/** One source file rendered as a building. Coordinates are world units on the XZ ground plane. */
export interface Building {
  /** {@link CodeGraph.files} id — repo-relative POSIX path; the join key back to the graph. */
  fileId: string;
  /** Center X coordinate on the ground plane. */
  x: number;
  /** Center Z coordinate on the ground plane. */
  z: number;
  /** Footprint width along X (encodes function/symbol count — never color, never importance). */
  w: number;
  /** Footprint depth along Z. */
  d: number;
  /** Height along Y, proportional to lines of code (the ONLY meaning height carries). */
  h: number;
}

/**
 * One folder rendered as a ground-level district block. Nested folders become
 * nested blocks: a district's rectangle fully contains the rectangles of its
 * child districts and their buildings. The root folder is NOT a district
 * (there is no block for "." / repo root) — only real subfolders are.
 */
export interface District {
  /**
   * Folder path, repo-relative POSIX style, matching the folder prefix of its
   * buildings' fileIds (root-level files live in no district).
   */
  path: string;
  /** Center X coordinate of the block. */
  x: number;
  /** Center Z coordinate of the block. */
  z: number;
  /** Block width along X (includes inner padding; fully contains children). */
  w: number;
  /** Block depth along Z. */
  d: number;
  /** Display label — the folder's own name (e.g. "parser" for "lib/parser"). */
  label: string;
  /** Nesting depth: 0 for a top-level folder, 1 for its subfolders, … */
  depth: number;
}

/**
 * One intra-repo import edge rendered as a ground-level polyline road from the
 * importing building to the imported building. One road per graph edge —
 * overlapping roads are fine at this phase (no routing/traffic yet).
 */
export interface Road {
  /** {@link ImportEdge.fromId} — the importing file. */
  fromId: string;
  /** {@link ImportEdge.toId} — the imported file. */
  toId: string;
  /**
   * Polyline waypoints on the XZ ground plane, in order: starts at the source
   * building's center, ends at the target building's center. Never empty.
   */
  points: Array<{ x: number; z: number }>;
}

/** The complete deterministic city layout a view renders from. */
export interface CityLayout {
  /** One building per graph file, sorted by fileId. */
  buildings: Building[];
  /**
   * District blocks sorted by path. Parents sort before children
   * (lexicographic on path does this naturally since "/" < any char).
   */
  districts: District[];
  /** Roads sorted by (fromId, toId). */
  roads: Road[];
  /** Repo-relative POSIX path of the graph this layout was computed from. */
  repoPath: string;
}

/**
 * Options for {@link computeCityLayout}. Every knob has a deterministic
 * default; passing the same options twice changes nothing.
 */
export interface CityLayoutOptions {
  /**
   * Target area (world units²) of the root rectangle the whole city occupies.
   * The root rectangle is always centered at the world origin (0, 0).
   * @default 100000 (≈365×274 at the 4:3 root aspect)
   */
  totalArea?: number;
  /**
   * Padding between a district block's edge and its content (buildings /
   * nested districts), in world units. Scales per nesting depth so deeply
   * nested blocks stay readable. Sets the STREET width between blocks: two
   * adjacent depth-0 districts sit 2×padding apart.
   * @default 4
   */
  districtPadding?: number;
  /**
   * World units of height per line of code. A 100-LOC file is 10 units tall
   * at the default.
   * @default 0.1
   */
  heightPerLoc?: number;
  /**
   * Minimum footprint (world units²) for any single building, so 1-line files
   * remain clickable.
   * @default 1
   */
  minFootprint?: number;
}

// ---------------------------------------------------------------------------
// Internal machinery — implementation detail; the exported types above are
// the contract components/city/ renders from.
// ---------------------------------------------------------------------------

/** Axis-aligned ground-plane rectangle. x/z is the min corner; w/d the extents. */
interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** A district (or the synthetic root) in the intermediate folder tree. */
interface DistrictNode {
  /** Folder path; "" for the root, which is never emitted as a District. */
  path: string;
  /** 0 for a top-level folder, +1 per nesting level; -1 for the root. */
  depth: number;
  /** Direct member files, sorted by id. */
  files: FileNode[];
  /** Direct sub-districts, sorted by path. */
  children: DistrictNode[];
  /** Bottom-up partition weight (formula documented in the header). */
  weight: number;
}

/** One participant in a treemap partition: a file (→ Building) or a district. */
interface PartitionItem {
  /** Defensive sort key: fileId for files, folder path for districts. */
  key: string;
  /** Partition weight in world units². */
  area: number;
  /** Set when the item is a file. */
  file?: FileNode;
  /** Set when the item is a district. */
  child?: DistrictNode;
}

/** Documented default for {@link CityLayoutOptions.totalArea}. */
const DEFAULT_TOTAL_AREA = 100000;
/** Documented default for {@link CityLayoutOptions.districtPadding}. */
const DEFAULT_DISTRICT_PADDING = 4;
/** Documented default for {@link CityLayoutOptions.heightPerLoc}. */
const DEFAULT_HEIGHT_PER_LOC = 0.1;
/** Documented default for {@link CityLayoutOptions.minFootprint}. */
const DEFAULT_MIN_FOOTPRINT = 1;

/**
 * Fraction of its treemap cell a building's footprint occupies. The cell is
 * pure partition area (at 1.0 buildings would tile edge-to-edge, walls
 * touching); shrinking to this fraction opens the yard gap between buildings
 * INSIDE a block. Street width BETWEEN blocks is
 * {@link CityLayoutOptions.districtPadding}.
 */
const FOOTPRINT_SCALE = 0.68;

/**
 * Hard cap on a building's footprint side (world units). Footprint area is
 * LOC-proportional, so without a cap a very large file becomes a huge slab
 * that dwarfs the street grid; capped, it grows UP instead — a slim tower
 * whose height still carries the LOC signal (the reference app's downtown).
 */
const MAX_FOOTPRINT_SIDE = 16;

/**
 * Weight floor for treemap participation. Reachable only when a caller
 * configures `minFootprint ≤ 0` with a 0-LOC file: the no-NaN contract must
 * hold unconditionally, so zero weights are clamped instead of dividing by
 * zero downstream.
 */
const MIN_WEIGHT = 1e-9;

/**
 * Dimension floor for exhausted rectangles inside {@link squarify} — a
 * float-dust guard that is unreachable with documented option ranges.
 */
const MIN_DIMENSION = 1e-9;

/**
 * Compute the city layout for a graph: recursive squarified treemap per
 * folder (root-level files and top-level districts partition the root
 * rectangle as siblings; each district's children partition its padded
 * interior). Pure and deterministic — no randomness, no Date.now(), no
 * environment-dependent iteration order: files, districts and roads are
 * defensively re-sorted here with plain `<` comparisons, and treemap ties
 * are broken by path, so not even an unsorted graph can change the output.
 *
 * Throws when `graph.files` is empty (nothing to lay out) with a clear,
 * stable error message — and never for anything else: malformed edges (an
 * endpoint with no matching file) are skipped, and out-of-range option
 * values are clamped rather than rejected.
 */
export function computeCityLayout(graph: CodeGraph, options?: CityLayoutOptions): CityLayout {
  if (graph.files.length === 0) {
    throw new Error("CityCode: cannot lay out an empty graph — no files");
  }

  // Options: partial merge over the documented defaults. Out-of-range values
  // are clamped (this function never throws except for the empty graph), so
  // the no-NaN contract holds even for hand-rolled option objects.
  const totalArea = Math.max(options?.totalArea ?? DEFAULT_TOTAL_AREA, MIN_WEIGHT);
  const districtPadding = Math.max(options?.districtPadding ?? DEFAULT_DISTRICT_PADDING, 0);
  const heightPerLoc = options?.heightPerLoc ?? DEFAULT_HEIGHT_PER_LOC;
  const minFootprint = options?.minFootprint ?? DEFAULT_MIN_FOOTPRINT;

  // Defensive copy + sort: the builder emits sorted arrays, but a pure
  // function's output must not depend on that promise.
  const files = graph.files.slice().sort((a, b) => compareStrings(a.id, b.id));

  // ---- Bottom-up: building areas ∝ LOC, normalized so the whole repo's
  // weights sum to totalArea. A repo where every file has 0 loc gets
  // minFootprint for everyone (scale 0 — never a division by zero).
  let totalLoc = 0;
  for (const file of files) {
    totalLoc += file.loc;
  }
  const locScale = totalLoc > 0 ? totalArea / totalLoc : 0;
  const weightFor = (loc: number): number => {
    const weight = Math.max(minFootprint, loc * locScale);
    return weight > 0 ? weight : MIN_WEIGHT; // reachable only when minFootprint ≤ 0
  };

  // ---- District tree: one node per non-empty POSIX dirname prefix of every
  // file id (intermediate folders included), plus the synthetic root ("").
  const root: DistrictNode = { path: "", depth: -1, files: [], children: [], weight: 0 };
  const nodesByPath = new Map<string, DistrictNode>([["", root]]);

  const districtPaths = new Set<string>();
  for (const file of files) {
    let prefix = posixDirname(file.id);
    while (prefix !== "") {
      districtPaths.add(prefix);
      prefix = posixDirname(prefix);
    }
  }
  // Plain-lexicographic order: a parent is always a strict prefix of its
  // children, so parents are created (and attached) before children here.
  const districtNodes: DistrictNode[] = [];
  for (const districtPath of Array.from(districtPaths).sort(compareStrings)) {
    const node: DistrictNode = {
      path: districtPath,
      depth: countSlashes(districtPath),
      files: [],
      children: [],
      weight: 0,
    };
    districtNodes.push(node);
    nodesByPath.set(districtPath, node);
    const parent = nodesByPath.get(posixDirname(districtPath));
    if (parent !== undefined) {
      parent.children.push(node);
    }
  }
  for (const file of files) {
    const parent = nodesByPath.get(posixDirname(file.id));
    if (parent !== undefined) {
      parent.files.push(file);
    }
  }

  // District weights, children first: reverse creation order visits every
  // district after all of its own children.
  for (let i = districtNodes.length - 1; i >= 0; i--) {
    const node = districtNodes[i];
    let content = 0;
    for (const file of node.files) {
      content += weightFor(file.loc);
    }
    for (const child of node.children) {
      content += child.weight;
    }
    const pad = paddingFor(node.depth, districtPadding);
    node.weight = Math.pow(2 * pad + Math.sqrt(content), 2);
  }

  // ---- Top-down: partition the root rectangle (fixed 4:3 landscape,
  // centered on the origin), then recurse into each district's padded
  // interior. The root itself is never a district — there is no block for ".".
  const rootWidth = Math.sqrt(totalArea * (4 / 3));
  const rootDepth = Math.sqrt(totalArea * (3 / 4));
  const rootRect: Rect = { x: -rootWidth / 2, z: -rootDepth / 2, w: rootWidth, d: rootDepth };

  const buildings: Building[] = [];
  const districts: District[] = [];

  const place = (node: DistrictNode, rect: Rect): void => {
    const items: PartitionItem[] = [];
    for (const file of node.files) {
      items.push({ key: file.id, area: weightFor(file.loc), file });
    }
    for (const child of node.children) {
      items.push({ key: child.path, area: child.weight, child });
    }
    for (const placement of squarify(items, rect)) {
      const cell = placement.rect;
      const file = placement.item.file;
      if (file !== undefined) {
        buildings.push(buildingFor(file, cell, weightFor(file.loc), heightPerLoc));
        continue;
      }
      const child = placement.item.child;
      if (child !== undefined) {
        districts.push(districtFor(child, cell));
        place(child, insetRect(cell, paddingFor(child.depth, districtPadding)));
      }
    }
  };
  place(root, rootRect);

  // ---- Roads: one per graph edge, endpoints at the two building centers
  // (ground level is the renderer's concern — no y here). Edges whose
  // endpoints never became files (malformed graph) have no center to draw
  // to and are skipped.
  const buildingById = new Map<string, Building>();
  for (const building of buildings) {
    buildingById.set(building.fileId, building);
  }
  const roads: Road[] = [];
  for (const edge of graph.edges) {
    const from = buildingById.get(edge.fromId);
    const to = buildingById.get(edge.toId);
    if (from === undefined || to === undefined) {
      continue;
    }
    roads.push({
      fromId: edge.fromId,
      toId: edge.toId,
      points: [
        { x: from.x, z: from.z },
        { x: to.x, z: to.z },
      ],
    });
  }

  // ---- Output contract: plain-`<` sorted arrays. District parents precede
  // children for free ("lib" < "lib/parser" in plain string order); road
  // ties (same pair, different symbols) are identical objects and the sort
  // is stable, so edges order is preserved.
  buildings.sort((a, b) => compareStrings(a.fileId, b.fileId));
  districts.sort((a, b) => compareStrings(a.path, b.path));
  roads.sort((a, b) => {
    if (a.fromId !== b.fromId) {
      return compareStrings(a.fromId, b.fromId);
    }
    return compareStrings(a.toId, b.toId);
  });

  return { buildings, districts, roads, repoPath: graph.repoPath };
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

/** Repo-relative POSIX dirname: "lib/parser/a.ts" → "lib/parser", "a.ts" → "". */
function posixDirname(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
}

/** Plain `<`/`>` comparison — localeCompare is banned (locale-dependent). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Folder nesting depth: 0 for a top-level folder, +1 per "/" inside. */
function countSlashes(folderPath: string): number {
  let depth = 0;
  for (let i = 0; i < folderPath.length; i++) {
    if (folderPath.charCodeAt(i) === 47) {
      depth += 1;
    }
  }
  return depth;
}

/** Padding a district insets before partitioning among its children. */
function paddingFor(depth: number, districtPadding: number): number {
  return districtPadding * (1 + 0.5 * depth);
}

/**
 * A district's child-partition region: the rect inset by `padding` on every
 * side, capped at a quarter of each dimension so even a tiny block keeps at
 * least half of every dimension for content — the region can never
 * degenerate to zero or negative.
 */
function insetRect(rect: Rect, padding: number): Rect {
  const effective = Math.min(padding, rect.w / 4, rect.d / 4);
  return {
    x: rect.x + effective,
    z: rect.z + effective,
    w: rect.w - 2 * effective,
    d: rect.d - 2 * effective,
  };
}

/**
 * Worst (largest) aspect ratio a strip with these aggregate stats would have
 * — the classic squarify objective, lower is better. Degenerate stats yield
 * Infinity so such rows are never preferred.
 */
function worstRatio(sum: number, max: number, min: number, stripLength: number): number {
  if (!(sum > 0) || !(min > 0) || !(stripLength > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    (stripLength * stripLength * max) / (sum * sum),
    (sum * sum) / (stripLength * stripLength * min),
  );
}

/**
 * Squarified treemap: partition `rect` among `items` proportionally to their
 * areas, greedily growing rows along the shorter side while the worst aspect
 * ratio does not worsen (Bruls et al., 2000).
 *
 * Determinism: items are re-sorted by (area desc, key asc) — a total order —
 * so the caller's array order can never leak into geometry.
 *
 * Robustness (together these make NaN/negative dimensions unreachable): the
 * final row absorbs the whole remaining extent (exact fill, no drift), any
 * other row's thickness is capped at the remaining extent, and an exhausted
 * rectangle is bumped to MIN_DIMENSION so queued items still get finite
 * cells.
 */
function squarify(
  items: readonly PartitionItem[],
  rect: Rect,
): Array<{ item: PartitionItem; rect: Rect }> {
  const placements: Array<{ item: PartitionItem; rect: Rect }> = [];
  if (items.length === 0) {
    return placements;
  }

  // Scale weights to sum to the rectangle's area, so the partition tiles the
  // rectangle exactly no matter how much padding districts have pre-paid.
  let totalWeight = 0;
  for (const item of items) {
    totalWeight += item.area;
  }
  const scale = totalWeight > 0 ? (rect.w * rect.d) / totalWeight : 1;
  const queue: PartitionItem[] = items.map((item) => ({ ...item, area: item.area * scale }));
  queue.sort((a, b) => (a.area !== b.area ? b.area - a.area : compareStrings(a.key, b.key)));

  let bounds = rect;
  let cursor = 0;
  while (cursor < queue.length) {
    if (!(bounds.w > 0) || !(bounds.d > 0)) {
      // Float dust exhausted the bounds an item early (unreachable with
      // documented option ranges) — bump to a minimal positive rectangle.
      bounds = { x: bounds.x, z: bounds.z, w: MIN_DIMENSION, d: MIN_DIMENSION };
    }
    const horizontal = bounds.w <= bounds.d;
    const stripLength = horizontal ? bounds.w : bounds.d; // row runs along the shorter side
    const remaining = horizontal ? bounds.d : bounds.w; // extent the row's thickness eats into

    // Greedily grow the row while the worst aspect ratio does not worsen.
    const row: PartitionItem[] = [];
    let rowSum = 0;
    let rowMax = 0;
    let rowMin = Number.POSITIVE_INFINITY;
    while (cursor < queue.length) {
      const next = queue[cursor];
      const candidateSum = rowSum + next.area;
      const candidateMax = Math.max(rowMax, next.area);
      const candidateMin = Math.min(rowMin, next.area);
      if (
        row.length === 0 ||
        worstRatio(candidateSum, candidateMax, candidateMin, stripLength) <=
          worstRatio(rowSum, rowMax, rowMin, stripLength)
      ) {
        row.push(next);
        rowSum = candidateSum;
        rowMax = candidateMax;
        rowMin = candidateMin;
        cursor += 1;
      } else {
        break;
      }
    }

    // Final row absorbs the whole remaining extent (exact fill); any other
    // row takes its natural thickness, never more than what remains.
    const thickness = cursor >= queue.length ? remaining : Math.min(rowSum / stripLength, remaining);

    let along = horizontal ? bounds.x : bounds.z;
    for (const item of row) {
      const share = stripLength * (item.area / rowSum); // the item's slice of the strip length
      placements.push(
        horizontal
          ? { item, rect: { x: along, z: bounds.z, w: share, d: thickness } }
          : { item, rect: { x: bounds.x, z: along, w: thickness, d: share } },
      );
      along += share;
    }
    bounds = horizontal
      ? { x: bounds.x, z: bounds.z + thickness, w: bounds.w, d: bounds.d - thickness }
      : { x: bounds.x + thickness, z: bounds.z, w: bounds.w - thickness, d: bounds.d };
  }
  return placements;
}

/**
 * Building from its allocated cell: center = cell center; footprint from the
 * aspect formula (see header) clamped into the cell so a symbol-heavy file
 * can never poke out of its district block; height = LOC, floored at 0.5 so
 * 1-line files stay clickable.
 *
 * The footprint is shrunk by {@link FOOTPRINT_SCALE} before clamping: a raw
 * treemap cell is pure partition, so at full size buildings tile their block
 * edge-to-edge. The shrink carves the uniform yard gap between neighboring
 * walls that the Small World diorama reads as streets and lawns.
 */
function buildingFor(file: FileNode, cell: Rect, area: number, heightPerLoc: number): Building {
  const aspect = Math.sqrt(Math.max(1, file.functions.length));
  let w = Math.sqrt(area * aspect) * FOOTPRINT_SCALE;
  let d = Math.sqrt(area / aspect) * FOOTPRINT_SCALE;
  // Large-file cap: excess footprint budget goes to height instead.
  if (w > MAX_FOOTPRINT_SIDE) w = MAX_FOOTPRINT_SIDE;
  if (d > MAX_FOOTPRINT_SIDE) d = MAX_FOOTPRINT_SIDE;
  if (w > cell.w) {
    w = cell.w;
    d = Math.min(area / w, cell.d);
  }
  if (d > cell.d) {
    d = cell.d;
    w = Math.min(area / d, cell.w);
  }
  return {
    fileId: file.id,
    x: cell.x + cell.w / 2,
    z: cell.z + cell.d / 2,
    w,
    d,
    h: Math.max(0.5, file.loc * heightPerLoc),
  };
}

/** District record from its allocated rect: center + full extents (padding included). */
function districtFor(node: DistrictNode, rect: Rect): District {
  return {
    path: node.path,
    x: rect.x + rect.w / 2,
    z: rect.z + rect.d / 2,
    w: rect.w,
    d: rect.d,
    label: node.path.slice(node.path.lastIndexOf("/") + 1),
    depth: node.depth,
  };
}

// ---------------------------------------------------------------------------
// Additive render-time helpers (Phase 3D) — pure functions the renderer may
// use to derive presentation geometry. They are NOT part of computeCityLayout
// and never touch its output: the persisted layout contract (center-to-center
// roads) is byte-identical with or without these helpers.
// ---------------------------------------------------------------------------

/** Gap (world units) between a building's footprint edge and a road endpoint. */
const ROUTE_EDGE_GAP = 0.5;

/**
 * Deterministic 32-bit string hash (the same multiply-xor family the renderer
 * already uses for slot hashing) — the source of stable "coin flips" for
 * routing orientation. Never Math.random: same input, same route, always.
 */
function hashString(value: string): number {
  let hash = 7;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Route one road between two buildings as a Manhattan-style path:
 * building-edge → single 90° corner → building-edge, instead of a straight
 * center-to-center diagonal that cuts through everything.
 *
 * Rules (all deterministic, all defensive):
 * - Orientation (X-then-Z vs Z-then-X) is a stable per-edge coin flip hashed
 *   from the endpoint ids, so a street grid emerges without randomness.
 * - Endpoints are trimmed from the building CENTER out to the footprint edge
 *   plus {@link ROUTE_EDGE_GAP}, so ribbons visually meet walls instead of
 *   vanishing under the buildings (buildings are opaque; an untrimmed center
 *   segment would be hidden anyway, but trimmed endpoints read as curbside).
 * - When the two buildings already share an axis the route degenerates to a
 *   straight 2-point line (no fake corner).
 * - The result is never empty and never contains coincident neighbors —
 *   callers can feed it straight into a ribbon/line builder.
 */
export function routeRoad(from: Building, to: Building): Array<{ x: number; z: number }> {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  // Coincident centers (pathological input): nothing sensible to route.
  if (dx === 0 && dz === 0) {
    return [
      { x: from.x, z: from.z },
      { x: to.x, z: to.z },
    ];
  }

  const horizontalFirst = (hashString(`${from.fileId}→${to.fileId}`) & 1) === 0;
  const aligned = dx === 0 || dz === 0;
  const corner = aligned
    ? null
    : horizontalFirst
      ? { x: to.x, z: from.z }
      : { x: from.x, z: to.z };

  const points: Array<{ x: number; z: number }> = [
    { x: from.x, z: from.z },
    ...(corner === null ? [] : [corner]),
    { x: to.x, z: to.z },
  ];

  // Trim the first/last points outward to the footprint edge. The trimmed
  // point slides along the segment direction by (half-extent + gap); a
  // segment shorter than the trim distance is left untouched (better a
  // slightly long road than a flipped one).
  const trimEndpoint = (building: Building, keep: number, move: number): void => {
    const segX = points[move].x - points[keep].x;
    const segZ = points[move].z - points[keep].z;
    const length = Math.hypot(segX, segZ);
    if (length === 0) return;
    const halfExtent = Math.abs(segX) >= Math.abs(segZ) ? building.w / 2 : building.d / 2;
    const trim = halfExtent + ROUTE_EDGE_GAP;
    if (trim >= length) return;
    points[keep] = {
      x: points[keep].x + (segX / length) * trim,
      z: points[keep].z + (segZ / length) * trim,
    };
  };
  trimEndpoint(from, 0, 1);
  trimEndpoint(to, points.length - 1, points.length - 2);

  return points;
}
