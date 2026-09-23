"use client";

/**
 * Districts — one flat slab per folder block, outlined with drei <Edges>.
 *
 * All depths share the same color: nesting is already expressed by the
 * geometry (contained rectangles + thicker padding at depth), so color-coding
 * depth would spend the reserved visual channel on information the eye can
 * already see. Labels are opt-in (store.showLabels) and rendered as drei
 * <Html> badges that never intercept pointer events.
 */

import { Edges, Html } from "@react-three/drei";

import type { District } from "@/lib/city/layout";
import { useCityStore } from "@/lib/store";

const DISTRICT_COLOR = "#2a2c33";
const DISTRICT_EDGE = "#3f424c";

export function Districts({ districts }: { districts: District[] }) {
  const showLabels = useCityStore((state) => state.showLabels);

  return (
    <group>
      {districts.map((district) => (
        <mesh key={district.path} position={[district.x, 0.1, district.z]}>
          <boxGeometry args={[district.w, 0.2, district.d]} />
          <meshStandardMaterial color={DISTRICT_COLOR} roughness={1} metalness={0} />
          <Edges color={DISTRICT_EDGE} />
          {showLabels && (
            <Html
              position={[0, 0.15, 0]}
              center
              zIndexRange={[10, 0]}
              style={{ pointerEvents: "none" }}
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap rounded border border-zinc-700/60 bg-zinc-950/70 px-1.5 py-0.5 backdrop-blur-[2px]">
                {/* CSS folder badge: body + tab, no icon font needed */}
                <span aria-hidden="true" className="relative block h-2 w-3 rounded-[1.5px] bg-zinc-500">
                  <span className="absolute -top-[3px] left-0 h-[3px] w-[6px] rounded-t-[1.5px] bg-zinc-500" />
                </span>
                <span className="font-mono text-[10px] leading-none text-zinc-300">
                  {district.label}
                </span>
              </span>
            </Html>
          )}
        </mesh>
      ))}
    </group>
  );
}
