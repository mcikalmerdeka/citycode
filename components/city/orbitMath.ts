/**
 * Pure camera math for the Small World diorama scene — no React, no three.js
 * objects, no side effects. Everything here is unit-testable in isolation and
 * shared by the camera rig (CityScene.tsx) and any future UI that needs to
 * reason about the orthographic viewpoint.
 *
 * ## The ortho/span camera model
 *
 * The reference look is an orthographic diorama: the camera orbits a target
 * point on a sphere of radius `distance`, and "zoom" changes the orthographic
 * frustum size (`span`) instead of moving the camera. This keeps perspective
 * distortion at zero at every zoom level — buildings stay parallel-edged —
 * which is what makes the Small World render read as a model, not a world.
 *
 * Conventions (matching three.js):
 * - `azimuth` is the ground-plane angle; azimuth 0 looks from +Z toward the
 *   origin, increasing azimuth rotates the camera counter-clockwise (viewed
 *   from above, +Y down).
 * - `elevation` is the angle above the ground plane: 0 = level with the
 *   target, π/2 = straight overhead.
 * - `span` is the vertical extent of the orthographic frustum in world units
 *   (top - bottom); left/right derive from the canvas aspect ratio.
 */

import type { CityLayout } from "@/lib/city/layout";
import type { DayPhase, Weather } from "@/lib/city/theme";

/** Camera limits — close enough to read a single building, far enough for the whole city. */
export const SPAN_MIN = 28;
export const SPAN_MAX = 460;
/** Elevation limits in radians — never level with the ground, never top-down. */
export const ELEVATION_MIN = 0.45;
export const ELEVATION_MAX = 1.25;

/** Default overview pose — a fresh city always opens from this vantage.
 * Span 250 frames the ≈365×274 root rect with its diorama margins. */
export const DEFAULT_ORBIT = {
  target: { x: 0, y: 0, z: 0 },
  span: 250,
  azimuth: -0.32,
  elevation: 0.66,
} as const;

/** A point in world space (kept as a plain object so this module stays pure). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The full orbit state the camera rig tweens between. */
export interface OrbitState {
  /** Look-at point in world space. */
  target: Vec3;
  /** Vertical frustum extent in world units (zoom). */
  span: number;
  /** Ground-plane angle in radians (free spin, unclamped). */
  azimuth: number;
  /** Angle above the ground plane in radians, clamped to [ELEVATION_MIN, ELEVATION_MAX]. */
  elevation: number;
}

/**
 * Symmetric orthographic frustum for a vertical extent of `span` at the
 * given canvas aspect ratio (width / height). Wide canvases widen left/right;
 * tall canvases widen top/bottom; the vertical extent is always exactly span.
 */
export function orthoFrustum(
  span: number,
  aspect: number,
): { left: number; right: number; top: number; bottom: number } {
  const half = span / 2;
  if (aspect >= 1) {
    return { left: -half * aspect, right: half * aspect, top: half, bottom: -half };
  }
  return { left: -half, right: half, top: half / aspect, bottom: -half / aspect };
}

/**
 * Camera position on the orbit sphere: `distance` from `target`, at
 * `elevation` above the ground plane, rotated `azimuth` around the Y axis.
 * Elevation π/2 puts the camera straight above the target; elevation 0 puts
 * it level with the target at ground distance `distance`.
 */
export function orbitPosition(
  target: Vec3,
  azimuth: number,
  elevation: number,
  distance: number,
): Vec3 {
  const ground = distance * Math.cos(elevation);
  return {
    x: target.x + ground * Math.sin(azimuth),
    y: target.y + distance * Math.sin(elevation),
    z: target.z + ground * Math.cos(azimuth),
  };
}

/** The clamped orbit values {@link clampedOrbit} returns (no target — it is stateless). */
export interface ClampedOrbit {
  azimuth: number;
  elevation: number;
  span: number;
}

/**
 * Clamp an orbit's elevation and span into the legal range. Azimuth is
 * deliberately unclamped — free 360° spin is part of the diorama feel.
 */
export function clampedOrbit(azimuth: number, elevation: number, span: number): ClampedOrbit {
  return {
    azimuth,
    elevation: Math.min(ELEVATION_MAX, Math.max(ELEVATION_MIN, elevation)),
    span: Math.min(SPAN_MAX, Math.max(SPAN_MIN, span)),
  };
}

// ---------------------------------------------------------------------------
// Layout bounds — the world-space rect the ground plane and diorama base are
// sized from.
// ---------------------------------------------------------------------------

/** Axis-aligned ground rect covering the city, in world units. */
export interface LayoutBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * The axis-aligned rect covering everything that stands on the ground in a
 * layout — every building footprint AND every district block. Districts are
 * essential here: they tile the root rectangle, so with footprint-shrunk
 * buildings the district patches extend past the footprint extent; sizing
 * the lawn/diorama base from buildings alone would let ground patches hang
 * over the slab edge. Districts tile the root rect, so this stays centered
 * on the world origin for any real layout. An empty layout falls back to
 * the default 200×200 root rect so the scene shell still has something
 * sensible to stand on.
 */
export function layoutBounds(layout: CityLayout): LayoutBounds {
  if (layout.buildings.length === 0 && layout.districts.length === 0) {
    return { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
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
  for (const district of layout.districts) {
    minX = Math.min(minX, district.x - district.w / 2);
    maxX = Math.max(maxX, district.x + district.w / 2);
    minZ = Math.min(minZ, district.z - district.d / 2);
    maxZ = Math.max(maxZ, district.z + district.d / 2);
  }
  return { minX, maxX, minZ, maxZ };
}

// ---------------------------------------------------------------------------
// Day/night + weather → normalized shader/lighting parameters.
// ---------------------------------------------------------------------------

/**
 * Normalized scene-environment parameters, one per SHADER_UNIFORMS entry.
 * Every value is in [0, 1]; renderers (Buildings, Roads, Environment) read
 * these to tint materials and drive effects without knowing the phase names.
 */
export interface EnvParams {
  /** 0 = full daylight, 1 = full night (dark sky, lit windows). */
  night: number;
  /** Warm low-sun tint: 0 = neutral daylight, 1 = deep golden hour. */
  dusk: number;
  /** 0 = windows dark, 1 = windows emissive (night). */
  lightsOn: number;
  /** 0 = dry, 1 = raining. */
  rain: number;
  /** 0 = clear sky, 1 = overcast. */
  cloud: number;
  /** 0 = still air, 1 = strong wind (sway amplitude for foliage/agents). */
  wind: number;
  /** 0 = dry ground, 1 = soaked ground (sheen + darker albedo). */
  wet: number;
}

/** Phase → base parameters. Weather is layered on top by {@link envParams}. */
const PHASE_PARAMS: Record<DayPhase, EnvParams> = {
  morning: { night: 0, dusk: 0.2, lightsOn: 0, rain: 0, cloud: 0, wind: 0, wet: 0 },
  noon: { night: 0, dusk: 0, lightsOn: 0, rain: 0, cloud: 0, wind: 0, wet: 0 },
  sunset: { night: 0, dusk: 0.6, lightsOn: 0, rain: 0, cloud: 0, wind: 0, wet: 0 },
  night: { night: 1, dusk: 0, lightsOn: 1, rain: 0, cloud: 0, wind: 0, wet: 0 },
};

/** Weather → additive layer. */
const WEATHER_PARAMS: Record<Weather, Partial<EnvParams>> = {
  clear: {},
  cloudy: { cloud: 1, wind: 0.3 },
  rain: { rain: 1, cloud: 1, wet: 1, wind: 0.5 },
};

/**
 * Map a (phase, weather) pair to the normalized uniform parameters the scene
 * materials consume. Pure — the same pair always yields the same object.
 */
export function envParams(phase: DayPhase, weather: Weather): EnvParams {
  const base = PHASE_PARAMS[phase];
  const layer = WEATHER_PARAMS[weather];
  return {
    night: base.night,
    dusk: base.dusk,
    lightsOn: base.lightsOn,
    rain: base.rain,
    cloud: base.cloud,
    wind: base.wind,
    wet: base.wet,
    ...layer,
  };
}
