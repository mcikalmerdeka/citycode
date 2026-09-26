/**
 * Vehicles — the drivable half of the living simulation. Pure, headless
 * logic over a road graph built from the road polylines in
 * `lib/city/paths.ts`: waypoint dedupe into a graph, BFS routing, right-hand
 * lane offsets, car-following with gap keeping and queuing, and rain-scaled
 * target speeds. No three.js, no React — `Simulation.tsx` only reads
 * positions/angles each frame.
 *
 * Car-following model (deliberately simple, per the Small World reference):
 * vehicles on the SAME directed leg (a→b) sort by progress; a follower's
 * allowed speed shrinks linearly to zero between DESIRED_GAP and MIN_GAP.
 * Intersections need no signals at diorama scale — queuing plus lane offsets
 * already read as traffic.
 */

import type { PathNetwork, VehAgent } from "./types";

/** Cruise speed range (world units per second). */
const CRUISE_MIN = 8;
const CRUISE_RANGE = 4;
/** Rain multiplies cruise by (1 - RAIN_PENALTY * rain). */
const RAIN_PENALTY = 0.35;
/** Car-following gaps (world units). */
const MIN_GAP = 4.4;
const DESIRED_GAP = 7;
/** Acceleration / braking (world units per second²). */
const ACCEL = 6;
const BRAKE = 12;
/** Right-hand lane offset (world units) from the road centerline. */
const LANE_OFFSET = 1.1;

/** A graph of deduped road waypoints with undirected adjacency. */
export interface RoadGraph {
  /** Unique waypoints (rounded to 2 decimals), insertion-ordered. */
  nodes: Array<{ x: number; z: number }>;
  /** Neighbor node indices per node. */
  adj: number[][];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Build the road graph: dedupe waypoints, link consecutive polyline points. */
export function buildRoadGraph(network: PathNetwork): RoadGraph {
  const nodes: Array<{ x: number; z: number }> = [];
  const indexByKey = new Map<string, number>();
  const adj: number[][] = [];
  const nodeFor = (point: { x: number; z: number }): number => {
    const key = `${round2(point.x)}|${round2(point.z)}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    nodes.push({ x: point.x, z: point.z });
    adj.push([]);
    indexByKey.set(key, index);
    return index;
  };
  for (const road of network.roads) {
    let prev = -1;
    for (const point of road.points) {
      const index = nodeFor(point);
      if (prev >= 0 && prev !== index) {
        adj[prev].push(index);
        adj[index].push(prev);
      }
      prev = index;
    }
  }
  return { nodes, adj };
}

/** Deterministic BFS over the road graph (node indices, inclusive). */
function roadBfs(adj: number[][], from: number, to: number): number[] {
  if (from === to) return [from];
  const parent = new Map<number, number>();
  parent.set(from, -1);
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const neighbor of adj[current]) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      if (neighbor === to) {
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

/** Spawn `count` vehicles at random graph nodes with random destinations. */
export function spawnVehicles(
  graph: RoadGraph,
  count: number,
  rng: () => number,
  idBase = 0,
): VehAgent[] {
  const agents: VehAgent[] = [];
  if (graph.nodes.length === 0) return agents;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rng() * graph.nodes.length);
    const destination = Math.floor(rng() * graph.nodes.length);
    const route = roadBfs(graph.adj, start, destination);
    const cruise = CRUISE_MIN + rng() * CRUISE_RANGE;
    agents.push({
      id: idBase + i,
      route: route.length >= 2 ? route : [start],
      leg: 0,
      s: 0,
      speed: cruise * 0.5,
      targetSpeed: cruise,
      cruise,
      queued: false,
    });
  }
  return agents;
}

/** Leg length between two route nodes (straight line — legs are chordal). */
function legLength(graph: RoadGraph, from: number, to: number): number {
  const a = graph.nodes[from];
  const b = graph.nodes[to];
  if (a === undefined || b === undefined) return 0;
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/**
 * Advance every vehicle by `dt` seconds, mutating in place. `rain` (0..1)
 * caps target speeds; car-following clamps followers behind leaders on the
 * same directed leg. On route completion the vehicle BFS-routes onward from
 * its final node — never teleports.
 */
export function stepVehicles(
  vehicles: VehAgent[],
  graph: RoadGraph,
  dt: number,
  rain: number,
  rng: () => number,
): void {
  if (graph.nodes.length === 0) return;
  const nodeCount = graph.nodes.length;

  // --- Car-following: group by directed leg key, clamp followers. ---
  const byLeg = new Map<string, VehAgent[]>();
  for (const veh of vehicles) {
    if (veh.leg >= veh.route.length - 1) continue;
    const key = `${veh.route[veh.leg]}>${veh.route[veh.leg + 1]}`;
    const list = byLeg.get(key);
    if (list === undefined) byLeg.set(key, [veh]);
    else list.push(veh);
  }
  const allowed = new Map<number, number>();
  for (const list of byLeg.values()) {
    list.sort((a, b) => b.s - a.s); // furthest along = leader
    for (let i = 0; i < list.length; i++) {
      const veh = list[i];
      const cruiseCap = veh.targetSpeed;
      let cap = cruiseCap;
      if (i > 0) {
        const leader = list[i - 1];
        const gap = leader.s - veh.s;
        if (gap < MIN_GAP) cap = 0;
        else if (gap < DESIRED_GAP) {
          const ratio = (gap - MIN_GAP) / (DESIRED_GAP - MIN_GAP);
          cap = Math.min(cap, leader.speed * ratio);
        }
      }
      allowed.set(veh.id, cap);
    }
  }

  // --- Integrate: accelerate/brake toward the allowed speed, advance. ---
  for (const veh of vehicles) {
    // Rain eases the target toward the capped cruise; dry weather restores.
    const cruiseTarget = veh.cruise * (1 - RAIN_PENALTY * rain);
    veh.targetSpeed += (cruiseTarget - veh.targetSpeed) * Math.min(1, dt * 0.8);
    const cap = allowed.get(veh.id) ?? veh.targetSpeed;
    if (cap < veh.speed) veh.speed = Math.max(cap, veh.speed - BRAKE * dt);
    else veh.speed = Math.min(cap, veh.speed + ACCEL * dt);
    veh.queued = veh.speed < 1.5;

    if (veh.route.length < 2) {
      // Idle at a node: pick a new destination.
      const current = veh.route[0];
      const destination = Math.floor(rng() * nodeCount);
      const route = roadBfs(graph.adj, current, destination);
      if (route.length >= 2) {
        veh.route = route;
        veh.leg = 0;
        veh.s = 0;
      }
      continue;
    }

    veh.s += veh.speed * dt;
    while (veh.s >= legLength(graph, veh.route[veh.leg], veh.route[veh.leg + 1])) {
      const consumed = legLength(graph, veh.route[veh.leg], veh.route[veh.leg + 1]);
      veh.s -= consumed;
      veh.leg += 1;
      if (veh.leg >= veh.route.length - 1) {
        // Arrived at the final node: route onward from here.
        const current = veh.route[veh.route.length - 1];
        const destination = Math.floor(rng() * nodeCount);
        const route = roadBfs(graph.adj, current, destination);
        if (route.length >= 2) {
          veh.route = route;
          veh.leg = 0;
          veh.s = Math.max(0, veh.s);
        } else {
          veh.leg = veh.route.length - 1;
          veh.s = 0;
          veh.speed = 0;
        }
        break;
      }
      if (consumed <= 0) break; // degenerate leg guard
    }
  }
}

/**
 * World position + heading of a vehicle: mid-leg interpolation with a
 * right-hand lane offset. `angle` is radians for rotation.y (0 = +Z).
 */
export function vehiclePosition(
  veh: VehAgent,
  graph: RoadGraph,
): { x: number; z: number; angle: number } {
  if (veh.route.length === 0) return { x: 0, z: 0, angle: 0 };
  if (veh.leg >= veh.route.length - 1) {
    const node = graph.nodes[veh.route[veh.route.length - 1]];
    return node !== undefined ? { x: node.x, z: node.z, angle: 0 } : { x: 0, z: 0, angle: 0 };
  }
  const from = graph.nodes[veh.route[veh.leg]];
  const to = graph.nodes[veh.route[veh.leg + 1]];
  if (from === undefined || to === undefined) return { x: 0, z: 0, angle: 0 };
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length <= 0) return { x: from.x, z: from.z, angle: 0 };
  const nx = dx / length;
  const nz = dz / length;
  // Right of the direction of travel (dir × up in XZ): (-nz, nx).
  const t = veh.s / length;
  return {
    x: from.x + dx * t + -nz * LANE_OFFSET,
    z: from.z + dz * t + nx * LANE_OFFSET,
    angle: Math.atan2(nx, nz),
  };
}
