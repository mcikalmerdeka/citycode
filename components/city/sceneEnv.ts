/**
 * Scene environment context — the Wave-1 handoff contract between the scene
 * shell (Unit A: CityScene/Environment/DioramaBase) and the sibling renderers
 * (Unit B: Buildings.tsx, Districts.tsx, Roads.tsx, sim agents).
 *
 * CityScene computes {@link EnvParams} from the store's timeOfDay/weather via
 * `envParams()` (orbitMath.ts) and provides them here. Any component inside
 * the scene tree reads them with `useSceneEnv()`:
 *
 * ```tsx
 * const env = useSceneEnv();
 * // env.night    — 0..1, 1 = full night (darken albedo, light windows)
 * // env.dusk     — 0..1, warm low-sun tint (sunset ~0.6, morning ~0.2)
 * // env.lightsOn — 0..1, 1 = windows emissive
 * // env.rain     — 0..1, 1 = raining (fall streaks / splash effects)
 * // env.cloud    — 0..1, 1 = overcast (soften shadows, desaturate sky)
 * // env.wind     — 0..1, sway amplitude for foliage/agents
 * // env.wet      — 0..1, 1 = soaked ground (sheen + darker albedo)
 * ```
 *
 * All values are normalized [0, 1] and change only when the user switches
 * phase/weather — cheap to consume in `useFrame` via a ref, or directly in
 * JSX props (React re-renders only on phase/weather changes, not per frame).
 */

import { createContext, useContext } from "react";

import type { EnvParams } from "./orbitMath";

/** Neutral daylight params — the context's fallback outside a provider. */
export const NEUTRAL_ENV: EnvParams = {
  night: 0,
  dusk: 0,
  lightsOn: 0,
  rain: 0,
  cloud: 0,
  wind: 0,
  wet: 0,
};

export const SceneEnvContext = createContext<EnvParams>(NEUTRAL_ENV);

/**
 * Read the current scene environment (day/night + weather) parameters.
 * Must be called from a component inside CityScene's provider tree.
 */
export function useSceneEnv(): EnvParams {
  return useContext(SceneEnvContext);
}
