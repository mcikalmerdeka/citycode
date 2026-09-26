/**
 * Client UI state for the city view (zustand).
 *
 * Deliberately tiny: the 3D scene is a pure function of the API layout plus
 * this store — no layout data lives here, so a new analysis result can never
 * be stale-mixed with an old selection. `compareMode` is pinned to "static"
 * until Phase 4/5 grow the compare views; it exists now so later phases can
 * subscribe without reshaping the store.
 *
 * Phase 3D additions (additive only — every pre-existing field keeps its
 * exact semantics):
 * - `hoveredId` — pointer-hover target, kept separate from `selectedId` so
 *   hover can drive cheap visual feedback without touching the inspect
 *   panel. Consumers that need per-frame reaction read it via
 *   `useCityStore.getState()` inside `useFrame` (no React re-renders on the
 *   pointer-move hot path).
 * - `focusRequest` — a camera wishlist entry: "fly the camera to this
 *   building". The `nonce` makes repeat requests for the SAME building
 *   re-trigger (subscribers watch the object identity/nonce, not just the
 *   id). The scene's camera rig is the only consumer today; any UI may
 *   produce requests.
 *
 * Wave 0 additions (additive only — every pre-existing field keeps its
 * exact semantics):
 * - `timeOfDay` / `weather` — ambient scene conditions; the scene reads them
 *   to drive shader uniforms (SHADER_UNIFORMS) and lighting.
 * - `simEnabled` — master switch for the living simulation (peds/vehicles);
 *   off freezes agents without unmounting the scene.
 * - `resetViewRequest` — a monotonic camera-reset nonce (same pattern as
 *   `focusRequest`): UI calls `requestResetView()`, the camera rig reacts to
 *   the counter changing.
 */

import { create } from "zustand";

import type { DayPhase, Weather } from "./city/theme";

/** Which graph the scene renders. Phase 2 only ever shows "static". */
export type CompareMode = "static" | "prev" | "workdir";

/** A request for the camera to fly to a building; nonce forces re-fire. */
export interface FocusRequest {
  fileId: string;
  nonce: number;
}

interface CityState {
  /** {@link import("./types").FileNode.id} of the selected building, or null. */
  selectedId: string | null;
  /** Compare view selector — "static" until Phase 4/5. */
  compareMode: CompareMode;
  /** Whether district (folder) labels float over the blocks. */
  showLabels: boolean;
  /** Building under the pointer, or null. Never drives hue — glow only. */
  hoveredId: string | null;
  /** Latest camera fly-to request, or null. Consumed by the scene CameraRig. */
  focusRequest: FocusRequest | null;
  /** Ambient time of day for the scene. */
  timeOfDay: DayPhase;
  /** Ambient weather for the scene. */
  weather: Weather;
  /** Master switch for the living simulation (pedestrians/vehicles). */
  simEnabled: boolean;
  /** Monotonic reset counter — UI increments, camera rig reacts to changes. */
  resetViewRequest: number;
  select: (id: string | null) => void;
  setCompareMode: (mode: CompareMode) => void;
  toggleLabels: () => void;
  setHovered: (id: string | null) => void;
  requestFocus: (fileId: string) => void;
  setTimeOfDay: (p: DayPhase) => void;
  setWeather: (w: Weather) => void;
  toggleSim: () => void;
  requestResetView: () => void;
}

export const useCityStore = create<CityState>((set, get) => ({
  selectedId: null,
  compareMode: "static",
  showLabels: false,
  hoveredId: null,
  focusRequest: null,
  timeOfDay: "noon",
  weather: "clear",
  simEnabled: true,
  resetViewRequest: 0,
  select: (id) => set({ selectedId: id }),
  setCompareMode: (compareMode) => set({ compareMode }),
  toggleLabels: () => set((state) => ({ showLabels: !state.showLabels })),
  setHovered: (id) => {
    // Hover fires per pointer-enter; skip no-op sets so subscribers (and any
    // future selectors) never see redundant transitions.
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  requestFocus: (fileId) =>
    set({ focusRequest: { fileId, nonce: (get().focusRequest?.nonce ?? 0) + 1 } }),
  setTimeOfDay: (p) => set({ timeOfDay: p }),
  setWeather: (w) => set({ weather: w }),
  toggleSim: () => set((state) => ({ simEnabled: !state.simEnabled })),
  requestResetView: () =>
    set({ resetViewRequest: get().resetViewRequest + 1 }),
}));
