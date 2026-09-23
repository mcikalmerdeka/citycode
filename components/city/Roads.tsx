"use client";

/**
 * Roads — one drei <Line> per import edge, floating just above the district
 * slabs (slab tops sit at y = 0.2; roads run at y = 0.35).
 *
 * Keys are index-based on purpose: the same (fromId → toId) pair can appear
 * multiple times (one edge per imported symbol), so the pair is not unique.
 * Roads with fewer than two waypoints are skipped defensively — the layout
 * contract says "never empty", but a degenerate line would crash the
 * renderer, not just look wrong.
 */

import { Line } from "@react-three/drei";

import type { Road } from "@/lib/city/layout";

const ROAD_COLOR = "#5a5d66";
const ROAD_Y = 0.35;
const ROAD_WIDTH = 2;

export function Roads({ roads }: { roads: Road[] }) {
  return (
    <group>
      {roads.map((road, index) => {
        if (road.points.length < 2) return null;
        const points = road.points.map(
          (point): [number, number, number] => [point.x, ROAD_Y, point.z],
        );
        return (
          <Line
            key={index}
            points={points}
            color={ROAD_COLOR}
            lineWidth={ROAD_WIDTH}
          />
        );
      })}
    </group>
  );
}
