"use client";

/**
 * Buildings — one instanced box per {@link Building}, plus a separate overlay
 * mesh for the selected building.
 *
 * Rules encoded here (PRD visual contract):
 * - Static view: ONE uniform color for every building. Hue is reserved for
 *   compare modes; per-building color variation is forbidden there.
 * - Compare view (Phase 4): per-instance colors by change status — orange
 *   construction sites, lime fresh builds, red blast-radius tint. A change
 *   status and the selection may co-exist: the status recolors the instance
 *   while selection stays the ×1.02 emissive overlay (never two colors on
 *   the same property — selection never carries hue, only glow).
 */

import { useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Instance, Instances } from "@react-three/drei";

import type { Building } from "@/lib/city/layout";
import type { NodeChange, NodeStatus } from "@/lib/diff/apply";
import { useCityStore } from "@/lib/store";

/** Uniform building color — neutral zinc, identical for every file. */
const BUILDING_COLOR = "#8b8d98";
/** Emissive tint of the selection overlay (mirrored by the Legend swatch). */
const SELECTED_EMISSIVE = "#e4a33c";
/** Overlay scale factor — just enough to clear the original faces. */
const SELECTION_SCALE = 1.02;

/** Compare-status colors — the ONLY places hue means anything (Legend pairs). */
export const STATUS_COLORS: Record<NodeStatus, string> = {
  construction: "#f59e0b", // amber — modified, construction site
  fresh: "#a3e635", // lime — added, fresh construction
  rubble: "#57534e", // warm grey — deleted, rubble (slab, not a building)
  moved: "#22d3ee", // cyan — renamed, moved marker
  blast: "#ef4444", // red — transitive importer of a changed file
};

export function Buildings({
  buildings,
  changes,
}: {
  buildings: Building[];
  changes?: Map<string, NodeChange>;
}) {
  const select = useCityStore((state) => state.select);
  const selectedId = useCityStore((state) => state.selectedId);

  const selected = useMemo(
    () => buildings.find((building) => building.fileId === selectedId) ?? null,
    [buildings, selectedId],
  );

  const colorOf = (building: Building): string => {
    const change = changes?.get(building.fileId);
    // Rubble nodes are never buildings (deleted files have no HEAD layout
    // entry) — the defensive fallthrough keeps any unexpected shape neutral.
    return change === undefined ? BUILDING_COLOR : STATUS_COLORS[change.status];
  };

  return (
    <group>
      {buildings.length > 0 && (
        <Instances limit={buildings.length} range={buildings.length}>
          <boxGeometry />
          <meshStandardMaterial roughness={0.85} metalness={0} />
          {buildings.map((building) => (
            <Instance
              key={building.fileId}
              color={colorOf(building)}
              position={[building.x, building.h / 2, building.z]}
              scale={[building.w, building.h, building.d]}
              onClick={(event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation();
                select(building.fileId);
              }}
              onPointerOver={(event: ThreeEvent<PointerEvent>) => {
                event.stopPropagation();
                document.body.style.cursor = "pointer";
              }}
              onPointerOut={() => {
                document.body.style.cursor = "auto";
              }}
            />
          ))}
        </Instances>
      )}

      {selected && (
        <mesh
          position={[
            selected.x,
            (selected.h * SELECTION_SCALE) / 2,
            selected.z,
          ]}
          scale={[
            selected.w * SELECTION_SCALE,
            selected.h * SELECTION_SCALE,
            selected.d * SELECTION_SCALE,
          ]}
        >
          <boxGeometry />
          {/* Selection color intentionally ignores compare hue: neutral box
              with the selection emissive on top, so the two channels never
              fight (hue = compare status, glow = selection). */}
          <meshStandardMaterial
            color={BUILDING_COLOR}
            emissive={SELECTED_EMISSIVE}
            emissiveIntensity={0.6}
            roughness={0.85}
            metalness={0}
          />
        </mesh>
      )}
    </group>
  );
}
