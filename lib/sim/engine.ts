/**
 * Simulation engine — the tick orchestrator that owns the seeded RNG and
 * steps pedestrians + vehicles together over one path network. Headless and
 * pure: the renderer creates a sim once per city and calls `stepSim` from a
 * fixed-timestep accumulator, reading positions for instanced meshes.
 *
 * Fixed timestep: the renderer accumulates real frame time and steps in
 * `STEP` quanta (max N per frame to avoid spiral-of-death after tab
 * pauses), keeping simulation time independent of display frame rate.
 */

import { buildSidewalkAdjacency, spawnPedestrians, stepPedestrians } from "./pedestrians";
import {
  buildRoadGraph,
  spawnVehicles,
  stepVehicles,
  type RoadGraph,
} from "./vehicles";
import type { PathNetwork, PedAgent, VehAgent } from "./types";

/** Fixed simulation step (seconds). */
export const STEP = 1 / 30;
/** Max steps per rendered frame — guards against background-tab catch-up. */
export const MAX_STEPS_PER_FRAME = 4;

/** Deterministic seeded PRNG (mulberry32) — the sim's only randomness. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything the sim owns between frames. */
export interface SimState {
  network: PathNetwork;
  sidewalkAdj: number[][];
  roadGraph: RoadGraph;
  peds: PedAgent[];
  vehs: VehAgent[];
  rng: () => number;
  /** Simulated seconds elapsed since creation. */
  time: number;
}

export interface SimCounts {
  pedestrians: number;
  vehicles: number;
}

/** Create a sim: build graphs, spawn agents, seed the RNG. */
export function createSim(
  network: PathNetwork,
  seed: number,
  counts?: Partial<SimCounts>,
): SimState {
  const pedestrians = counts?.pedestrians ?? 60;
  const vehicles = counts?.vehicles ?? 12;
  const rng = mulberry32(seed);
  const sidewalkAdj = buildSidewalkAdjacency(network.sidewalk);
  const roadGraph = buildRoadGraph(network);
  return {
    network,
    sidewalkAdj,
    roadGraph,
    peds: spawnPedestrians(network.sidewalk, pedestrians, rng),
    vehs: spawnVehicles(roadGraph, vehicles, rng, 1_000_000),
    rng,
    time: 0,
  };
}

/** Advance the sim by `dt` seconds (one fixed step). Mutates in place. */
export function stepSim(state: SimState, dt: number, rain: number): void {
  state.time += dt;
  stepPedestrians(state.peds, state.network.sidewalk, state.sidewalkAdj, dt, state.rng);
  stepVehicles(state.vehs, state.roadGraph, dt, rain, state.rng);
}
