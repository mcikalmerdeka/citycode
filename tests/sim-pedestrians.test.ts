import { describe, expect, it } from "vitest";
import { SIM_COLORS } from "@/lib/city/theme";
import {
  bfsPath,
  buildSidewalkAdjacency,
  pedPosition,
  spawnPedestrians,
  stepPedestrians,
} from "@/lib/sim/pedestrians";
import type { SidewalkNetwork } from "@/lib/sim/types";
import { mulberry32 } from "@/lib/sim/engine";

/** 3×3 grid sidewalk graph: nodes row-major, segments to right/down neighbors. */
function gridNetwork(): SidewalkNetwork {
  const nodes = [];
  for (let z = 0; z < 3; z++) {
    for (let x = 0; x < 3; x++) {
      nodes.push({ id: `sw-${x}-${z}`, x: x * 10, z: z * 10 });
    }
  }
  const segments: Array<{ a: string; b: string }> = [];
  const at = (x: number, z: number): string => `sw-${x}-${z}`;
  for (let z = 0; z < 3; z++) {
    for (let x = 0; x < 3; x++) {
      if (x < 2) segments.push({ a: at(x, z), b: at(x + 1, z) });
      if (z < 2) segments.push({ a: at(x, z), b: at(x, z + 1) });
    }
  }
  return { nodes, segments };
}

describe("buildSidewalkAdjacency", () => {
  it("maps every node index to its neighbor indices", () => {
    const network = gridNetwork();
    const adj = buildSidewalkAdjacency(network);
    expect(adj).toHaveLength(network.nodes.length);
    // Node 0 (0,0) connects to (10,0)=index 1 and (0,10)=index 3.
    expect(adj[0]).toEqual(expect.arrayContaining([1, 3]));
    // Corner node 8 (20,20) connects to 5 and 7.
    expect(adj[8]).toEqual(expect.arrayContaining([5, 7]));
  });
});

describe("bfsPath", () => {
  it("finds the shortest path between two nodes", () => {
    const adj = buildSidewalkAdjacency(gridNetwork());
    // 0=(0,0) … 8=(20,20): BFS explores right before down, so the shortest
    // path is [0,1,2,5,8] (right, right, down, down).
    expect(bfsPath(adj, 0, 8)).toEqual([0, 1, 2, 5, 8]);
  });

  it("returns a single-node path when from === to", () => {
    const adj = buildSidewalkAdjacency(gridNetwork());
    expect(bfsPath(adj, 4, 4)).toEqual([4]);
  });

  it("returns an empty path when the target is unreachable", () => {
    const network = gridNetwork();
    const adj = buildSidewalkAdjacency(network);
    // Sever node 8 from everything.
    const severed = adj.map((neighbors) => neighbors.filter((n) => n !== 8));
    severed[8] = [];
    expect(bfsPath(severed, 0, 8)).toEqual([]);
  });
});

describe("spawnPedestrians", () => {
  it("spawns the requested count with valid state", () => {
    const network = gridNetwork();
    const peds = spawnPedestrians(network, 12, mulberry32(7));
    expect(peds).toHaveLength(12);
    for (const ped of peds) {
      expect(ped.path.length).toBeGreaterThanOrEqual(2);
      expect(ped.leg).toBe(0);
      expect(ped.t).toBe(0);
      expect(ped.speed).toBeGreaterThan(0);
      expect(ped.shirt).toBeGreaterThanOrEqual(0);
      expect(ped.shirt).toBeLessThan(SIM_COLORS.shirts.length);
      expect(ped.pants).toBeLessThan(SIM_COLORS.pants.length);
      expect(ped.skin).toBeLessThan(SIM_COLORS.skins.length);
    }
  });

  it("is deterministic for the same seed", () => {
    const network = gridNetwork();
    expect(spawnPedestrians(network, 8, mulberry32(3))).toEqual(
      spawnPedestrians(network, 8, mulberry32(3)),
    );
  });
});

describe("stepPedestrians", () => {
  it("advances an agent along its path and reports positions via pedPosition", () => {
    const network = gridNetwork();
    const adj = buildSidewalkAdjacency(network);
    const peds = spawnPedestrians(network, 1, mulberry32(11));
    const ped = peds[0];
    // Force a known path along the bottom row: 0 → 1 → 2.
    ped.path = [0, 1, 2];
    ped.leg = 0;
    ped.t = 0;
    ped.speed = 10; // one grid edge (10u) per second
    ped.dwell = 0;

    const start = pedPosition(ped, network);
    expect(start.x).toBeCloseTo(0, 5);
    expect(start.z).toBeCloseTo(0, 5);

    stepPedestrians(peds, network, adj, 0.5, mulberry32(1));
    const half = pedPosition(ped, network);
    expect(half.x).toBeCloseTo(5, 5);
    expect(half.z).toBeCloseTo(0, 5);

    stepPedestrians(peds, network, adj, 0.5, mulberry32(1));
    const arrived = pedPosition(ped, network);
    expect(arrived.x).toBeCloseTo(10, 5);
    expect(arrived.z).toBeCloseTo(0, 5);
  });

  it("on arrival the agent dwells, then picks a new destination", () => {
    const network = gridNetwork();
    const adj = buildSidewalkAdjacency(network);
    const peds = spawnPedestrians(network, 1, mulberry32(5));
    const ped = peds[0];
    ped.path = [0, 1];
    ped.leg = 0;
    ped.t = 0;
    ped.speed = 10;
    ped.dwell = 0;

    // 1s to arrive + a dwell of up to ~8s: step well past both.
    for (let i = 0; i < 30; i++) {
      stepPedestrians(peds, network, adj, 0.5, mulberry32(9));
    }
    // Either still dwelling at node 1, or walking a fresh path from it.
    const at = pedPosition(ped, network);
    const atNode = ped.dwell > 0 ? 1 : ped.path[0];
    const node = network.nodes[atNode];
    if (ped.dwell > 0) {
      expect(at.x).toBeCloseTo(node.x, 4);
      expect(at.z).toBeCloseTo(node.z, 4);
    } else {
      expect(ped.path.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("is deterministic: same seed → identical positions after N steps", () => {
    const network = gridNetwork();
    const adj = buildSidewalkAdjacency(network);
    const run = (): number[] => {
      const peds = spawnPedestrians(network, 6, mulberry32(21));
      for (let i = 0; i < 120; i++) {
        stepPedestrians(peds, network, adj, 1 / 30, mulberry32(21 + i));
      }
      return peds.map((p) => Math.round(pedPosition(p, network).x * 100));
    };
    expect(run()).toEqual(run());
  });
});
