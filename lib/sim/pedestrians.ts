/**
 * Pedestrians — the walkable half of the living simulation. Pure, headless
 * logic over the sidewalk graph from `lib/city/paths.ts`: BFS routing,
 * leg-by-leg walking with per-agent speeds, dwell-at-destination, and
 * deterministic re-destination from a seeded RNG. No three.js, no React —
 * the renderer (`Simulation.tsx`) only reads positions each frame.
 *
 * Timing: the city spans ~200 world units, so walking speeds (3–5 u/s) read
 * as a lively miniature at the default span-185 view — a full crossing takes
 * roughly 40–60 seconds, matching the reference app's pace.
 */

import { SIM_COLORS } from "../city/theme";
import type { PedAgent, SidewalkNetwork } from "./types";

/** Walk speed range (world units per second). */
const SPEED_MIN = 3;
const SPEED_RANGE = 2;
/** Dwell range at a destination (seconds). */
const DWELL_MIN = 2;
const DWELL_RANGE = 6;
/** Initial dwell spread so a fresh crowd doesn't depart in lockstep. */
const STAGGER = 4;

/** Adjacency over sidewalk node INDICES (order = segment insertion order). */
export function buildSidewalkAdjacency(network: SidewalkNetwork): number[][] {
  const indexById = new Map<string, number>();
  network.nodes.forEach((node, index) => indexById.set(node.id, index));
  const adjacency: number[][] = network.nodes.map(() => []);
  for (const segment of network.segments) {
    const a = indexById.get(segment.a);
    const b = indexById.get(segment.b);
    if (a === undefined || b === undefined) continue;
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  return adjacency;
}

/** Deterministic BFS — returns node indices from `from` to `to` inclusive. */
export function bfsPath(adjacency: number[][], from: number, to: number): number[] {
  if (from === to) return [from];
  const parent = new Map<number, number>();
  parent.set(from, -1);
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const neighbor of adjacency[current]) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      if (neighbor === to) {
        // Reconstruct.
        const path: number[] = [];
        let node = to;
        while (node !== -1) {
          path.push(node);
          node = parent.get(node) ?? -1;
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }
  return [];
}

/** Spawn `count` pedestrians at random nodes with random destinations. */
export function spawnPedestrians(
  network: SidewalkNetwork,
  count: number,
  rng: () => number,
  idBase = 0,
): PedAgent[] {
  const adjacency = buildSidewalkAdjacency(network);
  const agents: PedAgent[] = [];
  if (network.nodes.length === 0) return agents;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rng() * network.nodes.length);
    // Guarantee a real journey: shift a same-node destination deterministically.
    const rolled = Math.floor(rng() * network.nodes.length);
    const destination = rolled === start ? (start + 1) % network.nodes.length : rolled;
    const path = bfsPath(adjacency, start, destination);
    agents.push({
      id: idBase + i,
      path: path.length >= 2 ? path : [start, start],
      leg: 0,
      t: 0,
      speed: SPEED_MIN + rng() * SPEED_RANGE,
      dwell: rng() * STAGGER, // de-synchronize first departures
      shirt: Math.floor(rng() * SIM_COLORS.shirts.length),
      pants: Math.floor(rng() * SIM_COLORS.pants.length),
      skin: Math.floor(rng() * SIM_COLORS.skins.length),
    });
  }
  return agents;
}

/**
 * Advance every pedestrian by `dt` seconds, mutating in place (the renderer
 * reads the same array objects — no per-frame allocations). Agents dwell at
 * their destination, then pick a fresh destination from the same node.
 */
export function stepPedestrians(
  peds: PedAgent[],
  network: SidewalkNetwork,
  adjacency: number[][],
  dt: number,
  rng: () => number,
): void {
  const nodeCount = network.nodes.length;
  for (const ped of peds) {
    if (nodeCount === 0) continue;
    if (ped.dwell > 0) {
      ped.dwell -= dt;
      if (ped.dwell <= 0) {
        // Depart: choose a new destination from the current node.
        const current = ped.path[ped.path.length - 1];
        const destination = Math.floor(rng() * nodeCount);
        const path = bfsPath(adjacency, current, destination);
        if (path.length >= 2) {
          ped.path = path;
          ped.leg = 0;
          ped.t = 0;
        } else {
          ped.dwell = DWELL_MIN; // try again shortly
        }
      }
      continue;
    }
    if (ped.path.length < 2) {
      ped.dwell = DWELL_MIN + rng() * DWELL_RANGE;
      continue;
    }
    const from = network.nodes[ped.path[ped.leg]];
    const to = network.nodes[ped.path[ped.leg + 1]];
    if (from === undefined || to === undefined) {
      ped.dwell = DWELL_MIN;
      continue;
    }
    const legLength = Math.hypot(to.x - from.x, to.z - from.z);
    if (legLength <= 0) {
      ped.leg += 1;
      continue;
    }
    ped.t += (ped.speed * dt) / legLength;
    while (ped.t >= 1) {
      ped.leg += 1;
      ped.t -= 1;
      if (ped.leg >= ped.path.length - 1) {
        // Arrived: clamp to the final node and dwell.
        ped.leg = ped.path.length - 1;
        ped.t = 0;
        ped.dwell = DWELL_MIN + rng() * DWELL_RANGE;
        break;
      }
    }
  }
}

/** World position of a pedestrian (mid-leg interpolation; final node at rest). */
export function pedPosition(
  ped: PedAgent,
  network: SidewalkNetwork,
): { x: number; z: number } {
  if (ped.path.length === 0) return { x: 0, z: 0 };
  if (ped.leg >= ped.path.length - 1) {
    const node = network.nodes[ped.path[ped.path.length - 1]];
    return node !== undefined ? { x: node.x, z: node.z } : { x: 0, z: 0 };
  }
  const from = network.nodes[ped.path[ped.leg]];
  const to = network.nodes[ped.path[ped.leg + 1]];
  if (from === undefined || to === undefined) return { x: 0, z: 0 };
  return {
    x: from.x + (to.x - from.x) * ped.t,
    z: from.z + (to.z - from.z) * ped.t,
  };
}
