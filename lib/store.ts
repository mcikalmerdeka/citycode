/**
 * Client UI state for the city view (zustand).
 *
 * Deliberately tiny: the 3D scene is a pure function of the API layout plus
 * this store — no layout data lives here, so a new analysis result can never
 * be stale-mixed with an old selection. `compareMode` is pinned to "static"
 * until Phase 4/5 grow the compare views; it exists now so later phases can
 * subscribe without reshaping the store.
 */

import { create } from "zustand";

/** Which graph the scene renders. Phase 2 only ever shows "static". */
export type CompareMode = "static" | "prev" | "workdir";

interface CityState {
  /** {@link import("./types").FileNode.id} of the selected building, or null. */
  selectedId: string | null;
  /** Compare view selector — "static" until Phase 4/5. */
  compareMode: CompareMode;
  /** Whether district (folder) labels float over the blocks. */
  showLabels: boolean;
  select: (id: string | null) => void;
  setCompareMode: (mode: CompareMode) => void;
  toggleLabels: () => void;
}

export const useCityStore = create<CityState>((set) => ({
  selectedId: null,
  compareMode: "static",
  showLabels: false,
  select: (id) => set({ selectedId: id }),
  setCompareMode: (compareMode) => set({ compareMode }),
  toggleLabels: () => set((state) => ({ showLabels: !state.showLabels })),
}));
