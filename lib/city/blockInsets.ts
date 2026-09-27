/**
 * Block insets — how far each district's rendered block has to pull back from
 * every side so that no tarmac ever covers it, plus the footprint repair that
 * keeps a street from running through a wall in the first place.
 *
 * Split out of lib/city/streets.ts because the pull-back is a rendering
 * contract in its own right: `Districts.tsx` reads it to inset each block box,
 * and it depends on the FINAL corridor geometry, not on the corridors as first
 * derived.
 *
 * ## Why this is one pass, and why it runs last
 *
 * A pull-back is a MAXIMUM over every street that touches a block side, and the
 * streets are narrowed twice: once by the shared-space clamp (so a street never
 * covers its parallel neighbour) and once by the footprint repair here. Deriving
 * the map before both would bake in widths that no longer exist, and PATCHING it
 * after — writing `corridor.width / 2` into a field that a wider street had set
 * — silently shrinks a block back into another street's tarmac. So:
 *
 * `merge -> shared-space clamp -> footprint repair (narrows corridors only) ->
 * deriveBlockInsets`
 *
 * `deriveBlockInsets` is therefore the ONLY writer of the inset map, and the
 * repair pass touches corridors alone.
 *
 * ## Derivation rules
 *
 * 1. **A street constrains the sides perpendicular to it, and only where its
 *    span reaches.** An "x" street runs along Z, so it bites into the block's X
 *    sides, and only within its own [from, to] in Z; a "z" street is the mirror.
 *    A street on the far side of the city never touches this block.
 * 2. **A side's pull-back is the max, over those streets, of the distance from
 *    the block's edge to that street's near kerb**, taken only when positive —
 *    a street that does not reach the edge pulls back nothing. `x` and `z` are
 *    the conservative per-axis values (apply each to both sides of its axis);
 *    `top` (-Z) and `bottom` (+Z) carry the split for the Z axis so a renderer
 *    can use the asymmetry.
 * 3. **Every value is clamped to a quarter of the block's short side** — the
 *    same rule lib/city/layout.ts uses when padding a block for its children —
 *    so a small block can never invert into a negative extent.
 *
 * ## Guarantees
 *
 * - **Pure and deterministic**: plain `<` comparisons, districts sorted by path
 *   so the map's iteration order is canonical, no randomness or timestamps.
 * - **Never throws** and never returns a non-finite value: a district with no
 *   streets beside it gets zeros, not NaN.
 */

import type { Building, District } from "./layout";
import type { StreetCorridor } from "./streets";

/**
 * How far a corridor may reach into a building's footprint (world units)
 * before it counts as running through a wall rather than past a kerb.
 */
const FOOTPRINT_CLEARANCE = 1;

/**
 * Float tolerance for "touching". A street whose span merely grazes a block
 * edge is float dust away from reaching it; anything beyond this epsilon does
 * reach.
 */
const EDGE_EPSILON = 1e-6;

/**
 * How far a block must pull back on each side, in world units.
 *
 * `x` and `z` are the conservative per-axis pull-backs (apply each to both
 * sides of that axis); `top` (the -Z side) and `bottom` (the +Z side) carry
 * the split value for the Z axis for renderers that want the asymmetry.
 */
export interface BlockInset {
  x: number;
  z: number;
  top: number;
  bottom: number;
}

/**
 * Narrow any corridor that runs more than {@link FOOTPRINT_CLEARANCE} into a
 * building's footprint back to `maxWidth` — never wider than it already was, so
 * a repair can never re-cover a parallel neighbour's tarmac. Corridors only;
 * the block pull-backs are derived afterwards from the final widths.
 *
 * `maxWidth` is the standard street width, passed in rather than imported so
 * this module depends on nothing but types from streets.ts — a value import
 * would close an import cycle between the two.
 */
export function narrowCorridorsAgainstFootprints(
  corridors: StreetCorridor[],
  buildings: readonly Building[],
  maxWidth: number,
): void {
  const sorted = buildings.slice().sort((a, b) => compareStrings(a.fileId, b.fileId));
  for (const corridor of corridors) {
    let worst = 0;
    for (const building of sorted) {
      const penetration = footprintPenetration(corridor, building);
      if (penetration > worst) {
        worst = penetration;
      }
    }
    if (worst <= FOOTPRINT_CLEARANCE) {
      continue;
    }
    corridor.width = Math.min(corridor.width, maxWidth);
  }
}

/**
 * Per-district pull-back from the FINAL corridor geometry — see rules 1-3.
 * Every district in the layout gets an entry, districts with no street beside
 * them included (zeros rather than a missing key, so a renderer never has to
 * special-case a miss).
 */
export function deriveBlockInsets(
  districts: readonly District[],
  corridors: readonly StreetCorridor[],
): Map<string, BlockInset> {
  const sorted = districts.slice().sort((a, b) => compareStrings(a.path, b.path));
  const insets = new Map<string, BlockInset>();
  for (const district of sorted) {
    const minX = district.x - district.w / 2;
    const maxX = district.x + district.w / 2;
    const minZ = district.z - district.d / 2;
    const maxZ = district.z + district.d / 2;
    let lowX = 0;
    let highX = 0;
    let top = 0;
    let bottom = 0;
    for (const corridor of corridors) {
      const half = corridor.width / 2;
      // Each side starts at 0 and only ever grows, which is what "taken only
      // when positive" means: a street that does not reach an edge (negative
      // distance) leaves the side at zero rather than pulling it outward.
      if (corridor.axis === "x") {
        // Runs along Z: bites into the X sides, within [from, to] in Z.
        if (corridor.to <= minZ + EDGE_EPSILON || corridor.from >= maxZ - EDGE_EPSILON) continue;
        if (corridor.center < district.x) lowX = Math.max(lowX, corridor.center + half - minX);
        else highX = Math.max(highX, maxX - (corridor.center - half));
      } else {
        // Runs along X: bites into the Z sides, within [from, to] in X.
        if (corridor.to <= minX + EDGE_EPSILON || corridor.from >= maxX - EDGE_EPSILON) continue;
        if (corridor.center < district.z) top = Math.max(top, corridor.center + half - minZ);
        else bottom = Math.max(bottom, maxZ - (corridor.center - half));
      }
    }
    const limit = Math.min(district.w, district.d) / 4;
    insets.set(district.path, {
      x: Math.min(Math.max(lowX, highX), limit),
      z: Math.min(Math.max(top, bottom), limit),
      top: Math.min(top, limit),
      bottom: Math.min(bottom, limit),
    });
  }
  return insets;
}

/**
 * How far `building`'s footprint reaches into `corridor`'s tarmac along the
 * corridor's width axis (the depth of the two tarmac/footprint intervals);
 * negative when the building clears both kerbs, or when the two do not overlap
 * along the corridor's own axis at all.
 */
function footprintPenetration(corridor: StreetCorridor, building: Building): number {
  const half = corridor.width / 2;
  if (corridor.axis === "x") {
    if (building.z + building.d / 2 <= corridor.from || building.z - building.d / 2 >= corridor.to) {
      return -1;
    }
    return (
      Math.min(building.x + building.w / 2, corridor.center + half) -
      Math.max(building.x - building.w / 2, corridor.center - half)
    );
  }
  if (building.x + building.w / 2 <= corridor.from || building.x - building.w / 2 >= corridor.to) {
    return -1;
  }
  return (
    Math.min(building.z + building.d / 2, corridor.center + half) -
    Math.max(building.z - building.d / 2, corridor.center - half)
  );
}

/** Plain `<`/`>` comparison — localeCompare is banned (locale-dependent). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
