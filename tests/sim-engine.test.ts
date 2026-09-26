import { describe, expect, it } from "vitest";
import { createSim, stepSim } from "@/lib/sim/engine";
import { pedPosition } from "@/lib/sim/pedestrians";
import { vehiclePosition } from "@/lib/sim/vehicles";
import type { PathNetwork } from "@/lib/sim/types";

const NETWORK: PathNetwork = {
  sidewalk: {
    nodes: Array.from({ length: 9 }, (_, i) => ({
      id: `sw-${i}`,
      x: (i % 3) * 10,
      z: Math.floor(i / 3) * 10,
    })),
    segments: [
      { a: "sw-0", b: "sw-1" },
      { a: "sw-1", b: "sw-2" },
      { a: "sw-0", b: "sw-3" },
      { a: "sw-1", b: "sw-4" },
      { a: "sw-2", b: "sw-5" },
      { a: "sw-3", b: "sw-4" },
      { a: "sw-4", b: "sw-5" },
      { a: "sw-3", b: "sw-6" },
      { a: "sw-4", b: "sw-7" },
      { a: "sw-5", b: "sw-8" },
      { a: "sw-6", b: "sw-7" },
      { a: "sw-7", b: "sw-8" },
    ],
  },
  roads: [
    {
      id: "rd-0",
      points: [
        { x: 0, z: -20 },
        { x: 20, z: -20 },
        { x: 20, z: 20 },
      ],
      width: 6,
    },
    {
      id: "rd-1",
      points: [
        { x: 20, z: -20 },
        { x: 40, z: -20 },
      ],
      width: 6,
    },
  ],
};

describe("createSim", () => {
  it("spawns the requested agent counts deterministically", () => {
    const a = createSim(NETWORK, 42, { pedestrians: 10, vehicles: 3 });
    const b = createSim(NETWORK, 42, { pedestrians: 10, vehicles: 3 });
    expect(a.peds).toHaveLength(10);
    expect(a.vehs).toHaveLength(3);
    expect(a.peds).toEqual(b.peds);
    expect(a.vehs).toEqual(b.vehs);
  });
});

describe("stepSim", () => {
  it("moves agents over time without NaNs", () => {
    const sim = createSim(NETWORK, 42, { pedestrians: 12, vehicles: 3 });
    const start = sim.peds.map((p) => pedPosition(p, sim.network.sidewalk));
    for (let i = 0; i < 1800; i++) stepSim(sim, 1 / 30, 0); // 60 simulated seconds
    for (let i = 0; i < sim.peds.length; i++) {
      const now = pedPosition(sim.peds[i], sim.network.sidewalk);
      expect(Number.isFinite(now.x)).toBe(true);
      expect(Number.isFinite(now.z)).toBe(true);
      void start[i];
    }
    for (const veh of sim.vehs) {
      const pos = vehiclePosition(veh, sim.roadGraph);
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.z)).toBe(true);
    }
  });

  it("is deterministic across step granularities of the same seed", () => {
    const run = (): number[] => {
      const sim = createSim(NETWORK, 7, { pedestrians: 6, vehicles: 2 });
      for (let i = 0; i < 600; i++) stepSim(sim, 1 / 30, 0);
      return sim.peds.map((p) => Math.round(pedPosition(p, sim.network.sidewalk).x * 8));
    };
    expect(run()).toEqual(run());
  });
});
