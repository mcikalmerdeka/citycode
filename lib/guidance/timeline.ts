/**
 * Demo timeline math — pure, so the player's pacing is unit-testable.
 *
 * One playhead `t` (seconds) runs over the whole demo. Step i owns
 * [starts[i], starts[i] + hops[i] + dwells[i]): first the data packet
 * travels from the previous step's building (the hop), then it rests at the
 * building while the narration is read (the dwell). Step 0 has no hop.
 */

export type Phase = "hop" | "dwell";

export interface Timeline {
  /** Playhead time at which each step begins. */
  starts: number[];
  /** Travel time into each step (0 for the first). */
  hops: number[];
  /** Reading time at each step. */
  dwells: number[];
  total: number;
}

export interface Located {
  index: number;
  phase: Phase;
  /** 0..1 within the current phase. */
  progress: number;
}

/** Packet travel time between two steps at 1× speed. */
export const HOP_SECONDS = 1.6;
const MIN_DWELL_SECONDS = 3.5;
const MAX_DWELL_SECONDS = 9;
/** ~215 words/minute plus a beat — long narrations get longer, within bounds. */
const SECONDS_PER_WORD = 0.28;
const DWELL_BASE_SECONDS = 2;

/** How long a step rests, scaled to how much there is to read. */
export function dwellSeconds(narration: string): number {
  const words = narration.trim().split(/\s+/).filter((word) => word.length > 0).length;
  return Math.min(MAX_DWELL_SECONDS, Math.max(MIN_DWELL_SECONDS, DWELL_BASE_SECONDS + words * SECONDS_PER_WORD));
}

export function buildTimeline(narrations: readonly string[], hopSeconds: number = HOP_SECONDS): Timeline {
  const starts: number[] = [];
  const hops: number[] = [];
  const dwells: number[] = [];
  let cursor = 0;
  narrations.forEach((narration, index) => {
    const hop = index === 0 ? 0 : hopSeconds;
    const dwell = dwellSeconds(narration);
    starts.push(cursor);
    hops.push(hop);
    dwells.push(dwell);
    cursor += hop + dwell;
  });
  return { starts, hops, dwells, total: cursor };
}

/**
 * Boundary tolerance: `start + hop` minus `start` is not exactly `hop` in
 * floating point, and a packet that has just landed must read as "dwell".
 */
const EPSILON = 1e-9;

/** Which step/phase the playhead is in (clamped to the timeline). */
export function locate(timeline: Timeline, t: number): Located {
  const count = timeline.starts.length;
  if (count === 0) return { index: 0, phase: "dwell", progress: 1 };
  if (t >= timeline.total - EPSILON) return { index: count - 1, phase: "dwell", progress: 1 };
  const time = Math.max(0, t);
  let index = 0;
  for (let i = count - 1; i >= 0; i--) {
    if (time >= timeline.starts[i]!) {
      index = i;
      break;
    }
  }
  const local = time - timeline.starts[index]!;
  const hop = timeline.hops[index]!;
  if (local < hop - EPSILON) return { index, phase: "hop", progress: local / hop };
  const dwell = timeline.dwells[index]!;
  return { index, phase: "dwell", progress: dwell > 0 ? Math.min(1, (local - hop) / dwell) : 1 };
}

/**
 * Playhead time to jump to for a step: its very start (the packet is about
 * to travel) or, when `arrived`, the moment the packet lands.
 */
export function stepStartTime(timeline: Timeline, index: number, arrived: boolean): number {
  const count = timeline.starts.length;
  if (count === 0) return 0;
  const i = Math.min(count - 1, Math.max(0, index));
  return timeline.starts[i]! + (arrived ? timeline.hops[i]! : 0);
}

/** Smoothstep — gentle start and stop for the packet's travel. */
export function easeInOut(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}
