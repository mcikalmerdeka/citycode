"use client";

/**
 * Buildings — one instanced box per {@link Building}, plus a separate overlay
 * mesh for the selected building.
 *
 * Rules encoded here (PRD visual contract):
 * - ONE uniform color for every building. Hue is reserved for compare modes;
 *   per-building color variation is forbidden in the static view.
 * - Selection is expressed as geometry + emissive, never hue: an overlay box
 *   scaled ×1.02 on every axis so its faces sit 2% off the original surfaces
 *   (no z-fighting), with its base exactly at ground level (y = h·1.02 / 2).
 */

import { useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Instance, Instances } from "@react-three/drei";

import type { Building } from "@/lib/city/layout";
import { useCityStore } from "@/lib/store";

/** Uniform building color — neutral zinc, identical for every file. */
const BUILDING_COLOR = "#8b8d98";
/** Emissive tint of the selection overlay (mirrored by the Legend swatch). */
const SELECTED_EMISSIVE = "#e4a33c";
/** Overlay scale factor — just enough to clear the original faces. */
const SELECTION_SCALE = 1.02;

export function Buildings({ buildings }: { buildings: Building[] }) {
  const select = useCityStore((state) => state.select);
  const selectedId = useCityStore((state) => state.selectedId);

  const selected = useMemo(
    () => buildings.find((building) => building.fileId === selectedId) ?? null,
    [buildings, selectedId],
  );

  return (
    <group>
      {buildings.length > 0 && (
        <Instances limit={buildings.length} range={buildings.length}>
          <boxGeometry />
          <meshStandardMaterial color={BUILDING_COLOR} roughness={0.85} metalness={0} />
          {buildings.map((building) => (
            <Instance
              key={building.fileId}
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
