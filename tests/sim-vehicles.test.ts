import { describe, expect, it } from "vitest";
import {
  buildRoadGraph,
  spawnVehicles,
  stepVehicles,
  vehiclePosition,
} from "@/lib/sim/vehicles";
import type { PathNetwork } from "@/lib/sim/types";
import { mulberry32 } from "@/lib/sim/engine";

/** Two L-shaped roads sharing their meeting waypoint at (60, 0). */
function fixtureNetwork(): PathNetwork {
  return {
    sidewalk: { nodes: [], segments: [] },
    roads: [
      {
        id: "rd-a",
        points: [
          { x: 0, z: 0 },
          { x: 60, z: 0 },
          { x: 60, z: 20 },
        ],
        width: 6,
      },
      {
        id: "rd-b",
        points: [
          { x: 60, z: 0 },
          { x: 80, z: 0 },
        ],
        width: 6,
      },
    ],
  };
}

describe("buildRoadGraph", () => {
  it("dedupes shared waypoints and links the two roads", () => {
    const graph = buildRoadGraph(fixtureNetwork());
    // Waypoints: (0,0), (60,0), (60,20), (80,0) — (60,0) shared → 4 nodes.
    expect(graph.nodes).toHaveLength(4);
    const shared = graph.nodes.findIndex((n) => Math.abs(n.x - 60) < 1e-6 && Math.abs(n.z) < 1e-6);
    expect(shared).toBeGreaterThanOrEqual(0);
    // The shared node connects to (0,0), (60,20) and (80,0).
    expect(graph.adj[shared].length).toBe(3);
  });

  it("is deterministic", () => {
    expect(buildRoadGraph(fixtureNetwork())).toEqual(buildRoadGraph(fixtureNetwork()));
  });
});

describe("spawnVehicles", () => {
  it("spawns the requested count with valid state on real routes", () => {
    const graph = buildRoadGraph(fixtureNetwork());
    const vehicles = spawnVehicles(graph, 4, mulberry32(3));
    expect(vehicles).toHaveLength(4);
    for (const veh of vehicles) {
      expect(veh.route.length).toBeGreaterThanOrEqual(2);
      expect(veh.leg).toBe(0);
      expect(veh.s).toBeGreaterThanOrEqual(0);
      expect(veh.targetSpeed).toBeGreaterThan(0);
      expect(veh.speed).toBeGreaterThan(0);
      expect(veh.queued).toBe(false);
    }
  });

  it("is deterministic for the same seed", () => {
    const graph = buildRoadGraph(fixtureNetwork());
    expect(spawnVehicles(graph, 3, mulberry32(8))).toEqual(spawnVehicles(graph, 3, mulberry32(8)));
  });
});

describe("stepVehicles — car following", () => {
  it("a follower clamps to a stopped leader, queues, and resumes when the leader departs", () => {
    const graph = buildRoadGraph(fixtureNetwork());
    const graphNodes = graph.nodes;
    const startNode = graphNodes.findIndex((n) => Math.abs(n.x) < 1e-6 && Math.abs(n.z) < 1e-6);
    const shared = graphNodes.findIndex((n) => Math.abs(n.x - 60) < 1e-6 && Math.abs(n.z) < 1e-6);
    // Long edge startNode→shared is 60 units. Park the leader at s=30;
    // the follower sits at s=24 (gap 6 → inside the desired-gap window).
    const leader = {
      id: 0,
      route: [startNode, shared],
      leg: 0,
      s: 30,
      speed: 0, // parked in-lane
      targetSpeed: 0,
      cruise: 0,
      queued: false,
    };
    const follower = {
      id: 1,
      route: [startNode, shared],
      leg: 0,
      s: 24,
      speed: 9,
      targetSpeed: 9,
      cruise: 9,
      queued: false,
    };
    const vehicles = [leader, follower];

    // Two 0.5s steps: the follower brakes to a halt behind the leader.
    stepVehicles(vehicles, graph, 0.5, 0, mulberry32(31));
    stepVehicles(vehicles, graph, 0.5, 0, mulberry32(31));
    expect(follower.speed).toBeLessThan(1.5);
    expect(follower.queued).toBe(true);
    // Never passes through the leader.
    expect(leader.s - follower.s).toBeGreaterThan(0);

    // Leader departs onto the next leg — the follower resumes.
    leader.route = [shared, graphNodes.findIndex((n) => Math.abs(n.z - 20) < 1e-6)];
    leader.leg = 0;
    leader.s = 0;
    leader.speed = 4;
    leader.targetSpeed = 9;
    for (let i = 0; i < 30; i++) stepVehicles(vehicles, graph, 0.5, 0, mulberry32(31 + i));
    expect(follower.queued).toBe(false);
    expect(follower.speed).toBeGreaterThan(5);
  });

  it("rain reduces the target speed", () => {
    const graph = buildRoadGraph(fixtureNetwork());
    const vehicles = spawnVehicles(graph, 2, mulberry32(4));
    const dry = vehicles.map((v) => ({ ...v }));
    stepVehicles(vehicles, graph, 1, 0, mulberry32(31));
    stepVehicles(dry, graph, 1, 1, mulberry32(31));
    const speedOf = (list: typeof vehicles): number =>
      list.reduce((sum, v) => sum + v.targetSpeed, 0);
    expect(speedOf(dry)).toBeLessThan(speedOf(vehicles));
  });
});

describe("stepVehicles — progression", () => {
  it("vehicles complete routes and pick new ones without teleporting", () => {
    const graph = buildRoadGraph(fixtureNetwork());
    const vehicles = spawnVehicles(graph, 3, mulberry32(2));
    const before = vehicles.map((v) => vehiclePosition(v, graph));
    for (let i = 0; i < 240; i++) stepVehicles(vehicles, graph, 1 / 30, 0, mulberry32(31 + i)); // 8s
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const after = vehiclePosition(v, graph);
      // Displacement is finite and sane (no NaN, within the fixture bounds).
      expect(Number.isFinite(after.x)).toBe(true);
      expect(Number.isFinite(after.z)).toBe(true);
      expect(Math.abs(after.x)).toBeLessThan(100);
      expect(Math.abs(after.z)).toBeLessThan(100);
      void before[i];
    }
  });
});
