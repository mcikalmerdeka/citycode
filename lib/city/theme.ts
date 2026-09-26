/**
 * City theme — the Small World warm-diorama palettes and the shader uniform
 * vocabulary, in one place so every renderer (ground, buildings, trees, sim
 * agents, compare overlays) reads the same tokens.
 *
 * Wave 0 contract: downstream waves import these constants verbatim. The
 * reference values come from the Small World app; named keys are load-bearing
 * (tests pin them), so adding keys is safe but renaming/removing is not.
 *
 * `COMPARE_ACCENTS` keys mirror the compare-status names already used by
 * `components/city/Buildings.tsx` (`STATUS_COLORS`), so a status name never
 * has two spellings across the codebase.
 */

/** Page-level chrome colors (HTML UI around the canvas). */
export const PAGE_COLORS = {
  page: "#F7F7F8",
  backdrop: "#e8e9e4",
} as const;

/** Ground-plane palette: lawns, plazas, sidewalks, roads. */
export const GROUND_COLORS = {
  lawn: "#A9B797",
  lawnDeep: "#9DAD8C",
  yard: "#D0D3C3",
  plaza: "#D9D1C3",
  sidewalk: "#D7D1C6",
  curb: "#E6E1D8",
  asphalt: "#77746F",
  marking: "#ECE7DC",
  gravel: "#DDD4C2",
  /** Scene backdrop behind/under the diorama (matches PAGE_COLORS.backdrop). */
  backdrop: "#e8e9e4",
} as const;

/**
 * Building palette: walls, roofs, brick. `wallTones` gives the diorama its
 * non-identical-house variety (the reference app's facades alternate cream,
 * sand, clay, and sage-cream walls); `roofTones` spreads terracotta dominance
 * with occasional ochre and slate. `wallCream`/`wallPale` stay for the hover
 * and selection overlays.
 */
export const BUILDING_COLORS = {
  wallCream: "#D9D3C9",
  wallPale: "#E8E2D6",
  wallTones: [
    "#D9D3C9", // cream
    "#E8E2D6", // pale
    "#E3D3B2", // warm sand
    "#DDC7B0", // clay
    "#D5D2BC", // sage-cream
  ] as const,
  roofTerracotta: "#B8674A",
  roofOchre: "#C98B4E",
  roofSlate: "#6E7B8B",
  redbrick: "#A0522D",
} as const;

/** Tree palette: canopies + trunks. */
export const TREE_COLORS = {
  canopySage: "#8FA583",
  canopyAutumn: "#C98B4E",
  trunk: "#7A6A55",
} as const;

/**
 * Living-simulation palette: muted distinct shirt tones, dark neutral pants,
 * a small skin-tone range, and vehicle body colors.
 */
export const SIM_COLORS = {
  shirts: [
    "#C86B5A",
    "#5A7A9C",
    "#C9A227",
    "#7A9A6B",
    "#B05F82",
    "#4E6E8E",
  ] as const,
  pants: ["#3E3A36", "#54504A", "#2E3440", "#6B5D4F"] as const,
  skins: ["#E8B89A", "#C68B62", "#8D5B3F"] as const,
  vehicleBody: ["#C9C4BA", "#5A7A9C", "#B8674A", "#3E3A36"] as const,
} as const;

/**
 * Compare-mode accent colors, keyed by the exact status names from
 * `components/city/Buildings.tsx` STATUS_COLORS (construction / fresh /
 * foundation / rubble / moved / blast).
 */
export const COMPARE_ACCENTS = {
  construction: "#D9A441",
  fresh: "#7A9A6B",
  foundation: "#E8E2D6",
  rubble: "#8E8474",
  moved: "#5A8FA8",
  blast: "#C05B4A",
} as const;

/**
 * Shader uniform names the scene materials understand. A tuple (not an
 * object) so renderers can iterate it in a fixed order.
 */
export const SHADER_UNIFORMS = [
  "night",
  "dusk",
  "lightsOn",
  "rain",
  "cloud",
  "wind",
  "wet",
] as const;

/** Time-of-day phases the scene can render. */
export const DAY_PHASES = ["morning", "noon", "sunset", "night"] as const;
/** Weather states the scene can render. */
export const WEATHERS = ["clear", "cloudy", "rain"] as const;

export type DayPhase = (typeof DAY_PHASES)[number];
export type Weather = (typeof WEATHERS)[number];
