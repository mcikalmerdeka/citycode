/**
 * Flow player state (zustand) — what the guided demo is, where it is, and
 * whether it is playing. Shared by the DOM player (components/ui/DemoPlayer)
 * and the in-scene overlay (components/city/FlowOverlay), which live in
 * different React roots; a module-level store is the bridge, same as
 * lib/store.ts.
 *
 * Two kinds of state, kept apart on purpose:
 * - Discrete (store): which step, hop or dwell, playing, speed, toggles.
 *   Changes a handful of times per step, so React re-renders are cheap.
 * - Continuous ({@link flowClock}): the playhead in seconds. Written every
 *   frame by {@link tickFlow}; readers that need it (the packet, the
 *   progress bar) poll it per frame instead of subscribing, so playback
 *   never causes a React render storm.
 */

import { create } from "zustand";

import {
  HOP_SECONDS,
  buildTimeline,
  locate,
  stepStartTime,
  type Located,
  type Phase,
  type Timeline,
} from "./timeline";
import type { CodeExcerpt } from "./types";

/** One stop of a demo — only what the player and the scene need. */
export interface FlowStep {
  fileId: string;
  title: string;
  narration: string;
  /** Data handed to the next step; shown on the travelling packet. */
  payload?: string;
  startLine?: number;
  endLine?: number;
  /** Absent for tours and for files that could not be read. */
  excerpt?: CodeExcerpt;
}

export interface FlowSpec {
  /** "flow" follows data between files; "tour" walks a reading path. */
  kind: "flow" | "tour";
  title: string;
  subtitle?: string;
  steps: FlowStep[];
}

export interface ActiveFlow extends FlowSpec {
  timeline: Timeline;
}

export const FLOW_SPEEDS: readonly number[] = [0.5, 1, 1.5, 2];

/** Playhead in seconds. Mutated by {@link tickFlow}; deliberately not reactive. */
export const flowClock = { t: 0 };

/** A long frame (tab was hidden) must not teleport the packet. */
const MAX_FRAME_DELTA = 0.1;
const REDUCED_MOTION_HOP_SECONDS = 0.25;

interface FlowState {
  flow: ActiveFlow | null;
  index: number;
  phase: Phase;
  playing: boolean;
  /** Playback reached the end — the play button becomes "replay". */
  finished: boolean;
  speed: number;
  /** Camera follows the demo (frames each hop, focuses each stop). */
  follow: boolean;
  showCode: boolean;
  start: (spec: FlowSpec) => void;
  stop: () => void;
  togglePlay: () => void;
  seekTo: (t: number) => void;
  goToStep: (index: number) => void;
  setSpeed: (speed: number) => void;
  toggleFollow: () => void;
  toggleCode: () => void;
  /** Called by the ticker when the playhead crosses into a new step/phase. */
  sync: (index: number, phase: Phase) => void;
  finish: () => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const useFlowStore = create<FlowState>((set, get) => ({
  flow: null,
  index: 0,
  phase: "dwell",
  playing: false,
  finished: false,
  speed: 1,
  follow: true,
  showCode: true,

  start: (spec) => {
    if (spec.steps.length === 0) return;
    const hop = prefersReducedMotion() ? REDUCED_MOTION_HOP_SECONDS : HOP_SECONDS;
    flowClock.t = 0;
    set({
      flow: { ...spec, timeline: buildTimeline(spec.steps.map((step) => step.narration), hop) },
      index: 0,
      phase: "dwell",
      playing: true,
      finished: false,
    });
  },

  stop: () => {
    flowClock.t = 0;
    set({ flow: null, index: 0, phase: "dwell", playing: false, finished: false });
  },

  togglePlay: () => {
    const { flow, playing, finished } = get();
    if (flow === null) return;
    // Pressing play on a finished demo replays it from the top.
    if (finished) {
      flowClock.t = 0;
      set({ index: 0, phase: "dwell", playing: true, finished: false });
      return;
    }
    set({ playing: !playing });
  },

  seekTo: (t) => {
    const { flow } = get();
    if (flow === null) return;
    flowClock.t = Math.min(flow.timeline.total, Math.max(0, t));
    const located = locate(flow.timeline, flowClock.t);
    set({ index: located.index, phase: located.phase, finished: false });
  },

  goToStep: (index) => {
    const { flow, playing, seekTo } = get();
    if (flow === null) return;
    // While playing, land at the step's start so the packet's hop is seen;
    // while paused, land where it has arrived so the step reads as "here".
    seekTo(stepStartTime(flow.timeline, index, !playing));
  },

  setSpeed: (speed) => set({ speed }),
  toggleFollow: () => set((state) => ({ follow: !state.follow })),
  toggleCode: () => set((state) => ({ showCode: !state.showCode })),
  sync: (index, phase) => set({ index, phase }),
  finish: () => set({ playing: false, finished: true }),
}));

/**
 * Advance the playhead by one frame and keep the discrete state in step
 * with it. Called once per frame by the scene overlay; returns where the
 * playhead is (null when no demo is active).
 */
export function tickFlow(deltaSeconds: number): Located | null {
  const state = useFlowStore.getState();
  const { flow } = state;
  if (flow === null) return null;
  if (state.playing) {
    const advanced = flowClock.t + Math.min(deltaSeconds, MAX_FRAME_DELTA) * state.speed;
    flowClock.t = Math.min(flow.timeline.total, advanced);
  }
  const located = locate(flow.timeline, flowClock.t);
  if (state.playing && flowClock.t >= flow.timeline.total) state.finish();
  if (located.index !== state.index || located.phase !== state.phase) {
    state.sync(located.index, located.phase);
  }
  return located;
}
