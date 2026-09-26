/**
 * Day cycle & weather — the environment state machine. A single mutable
 * `envUniforms` object (one per process, mutated per frame by the renderer's
 * env driver) eases toward the target values computed by `envParams()` in
 * `components/city/orbitMath.ts`. Field names match the
 * `SHADER_UNIFORMS` contract in `lib/city/theme.ts` exactly.
 *
 * Exponential approach gives the reference app's "gentle transitions" —
 * switching to night takes a few seconds, never a hard cut. Wetness is the
 * one field with its own dynamics: it ACCUMULATES while raining and dries
 * slowly after, so surfaces stay damp for a while after the rain stops.
 */

/** Normalized (0..1) shader-uniform state — matches SHADER_UNIFORMS. */
export interface EnvUniforms {
  night: number;
  dusk: number;
  lightsOn: number;
  rain: number;
  cloud: number;
  wind: number;
  wet: number;
}

/** The module-level uniform state — mutated per frame, read by materials. */
export const envUniforms: EnvUniforms = {
  night: 0,
  dusk: 0,
  lightsOn: 0,
  rain: 0,
  cloud: 0,
  wind: 0,
  wet: 0,
};

/** Zero the module state (used by tests and scene resets). */
export function resetEnvUniforms(): void {
  envUniforms.night = 0;
  envUniforms.dusk = 0;
  envUniforms.lightsOn = 0;
  envUniforms.rain = 0;
  envUniforms.cloud = 0;
  envUniforms.wind = 0;
  envUniforms.wet = 0;
}

/** Exponential approach rate for the direct fields (1/seconds). */
const APPROACH_RATE = 1.4;
/** Wetness accumulation rate while raining (per second, scaled by rain). */
const WET_RATE = 0.09;
/** Wetness drying rate when clear (per second). */
const DRY_RATE = 0.03;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Advance the uniform state toward `target` by `dt` seconds, mutating
 * `envUniforms` in place. Direct fields ease exponentially; wetness
 * accumulates under rain and dries otherwise. Deterministic: same call
 * sequence → same state.
 */
export function stepEnvUniforms(target: Readonly<EnvUniforms>, dt: number): void {
  const approach = 1 - Math.exp(-APPROACH_RATE * dt);
  envUniforms.night = clamp01(envUniforms.night + (target.night - envUniforms.night) * approach);
  envUniforms.dusk = clamp01(envUniforms.dusk + (target.dusk - envUniforms.dusk) * approach);
  envUniforms.lightsOn = clamp01(
    envUniforms.lightsOn + (target.lightsOn - envUniforms.lightsOn) * approach,
  );
  envUniforms.rain = clamp01(envUniforms.rain + (target.rain - envUniforms.rain) * approach);
  envUniforms.cloud = clamp01(envUniforms.cloud + (target.cloud - envUniforms.cloud) * approach);
  envUniforms.wind = clamp01(envUniforms.wind + (target.wind - envUniforms.wind) * approach);
  if (target.rain > 0.05) {
    envUniforms.wet = clamp01(envUniforms.wet + WET_RATE * target.rain * dt);
  } else {
    envUniforms.wet = clamp01(envUniforms.wet - DRY_RATE * dt);
  }
}
