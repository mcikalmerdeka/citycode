/**
 * Living-simulation contracts — types only, no logic.
 *
 * These describe the pedestrian/vehicle path networks the sim walks agents
 * over, plus the agent state itself. Kept free of logic so both the sim
 * (Wave 1+) and the renderer can import them without coupling.
 *
 * Coordinates are world units on the XZ ground plane, matching
 * {@link import("../city/layout").Building} geometry.
 */

import type { DayPhase, Weather } from "../city/theme";

/** A walkable point on the sidewalk graph, keyed by string id. */
export interface SidewalkNode {
  /** Stable node id — segments reference nodes by this id. */
  id: string;
  /** X coordinate on the ground plane. */
  x: number;
  /** Z coordinate on the ground plane. */
  z: number;
}

/** An undirected sidewalk edge between two {@link SidewalkNode} ids. */
export interface SidewalkSegment {
  /** Id of one endpoint node. */
  a: string;
  /** Id of the other endpoint node. */
  b: string;
}

/** The walkable sidewalk graph: nodes + segments between them. */
export interface SidewalkNetwork {
  nodes: SidewalkNode[];
  segments: SidewalkSegment[];
}

/** A road centerline as an ordered polyline with a constant width. */
export interface RoadPolyline {
  /** Stable road id. */
  id: string;
  /** Ordered polyline vertices (XZ ground plane). */
  points: { x: number; z: number }[];
  /** Road width in world units. */
  width: number;
}

/** Everything the sim needs to know about the walkable/drivable space. */
export interface PathNetwork {
  sidewalk: SidewalkNetwork;
  roads: RoadPolyline[];
}

/**
 * A pedestrian walking the sidewalk graph. `path` holds node INDICES into
 * `SidewalkNetwork.nodes` (not ids) so the per-frame hot path never does
 * id→index lookups; `leg` is the index of the current path edge and `t` the
 * normalized progress (0..1) along it.
 */
export interface PedAgent {
  /** Stable agent id. */
  id: number;
  /** Node indices (into SidewalkNetwork.nodes) the agent walks, in order. */
  path: number[];
  /** Index of the current leg (path[leg] → path[leg + 1]). */
  leg: number;
  /** Normalized progress along the current leg (0..1). */
  t: number;
  /** Walk speed in world units per second. */
  speed: number;
  /** Seconds remaining of the current dwell at the destination (0 = moving). */
  dwell: number;
  /** Index into SIM_COLORS.shirts. */
  shirt: number;
  /** Index into SIM_COLORS.pants. */
  pants: number;
  /** Index into SIM_COLORS.skins. */
  skin: number;
}

/**
 * A vehicle driving the road network. `route` holds node INDICES into the
 * road graph built from `PathNetwork.roads` (see `buildRoadGraph` in
 * `lib/sim/vehicles.ts`); `s` is the distance travelled along the current
 * leg (node → node) so car-following can compare progress on shared legs.
 */
export interface VehAgent {
  /** Stable agent id. */
  id: number;
  /** Road-graph node indices the vehicle drives, in order. */
  route: number[];
  /** Index of the current leg (route[leg] → route[leg + 1]). */
  leg: number;
  /** Distance travelled along the current leg, in world units. */
  s: number;
  /** Current speed in world units per second. */
  speed: number;
  /** Desired speed right now — rain caps this below `cruise`. */
  targetSpeed: number;
  /** Personal dry-weather cruising speed. */
  cruise: number;
  /** True while queued behind another vehicle (car-following halt). */
  queued: boolean;
}

/** Ambient scene condition bundle the sim and shaders read together. */
export interface SimEnvironment {
  timeOfDay: DayPhase;
  weather: Weather;
}
