"use client";

/**
 * ChangeOverlays — the Phase 4 compare-only ground/feature treatments that
 * have no counterpart in the static view:
 *
 * - Construction-site crane markers over modified buildings (amber mast +
 *   slowly rotating jib — the plan's animated marker).
 * - Grey rubble slabs for deleted files: positioned at their old district
 *   spot via {@link parentDistrict}, deterministic per fileId so the same
 *   commit always renders identically.
 * - Cyan moved-from→moved-to ground lines for renames: origin spot computed
 *   the same rubble way (the old path has no building in the HEAD layout).
 * - (Phase 5) Pale foundation slabs for untracked files with no building in
 *   the captured layout; untracked files that ARE in the layout are flipped
 *   into low slabs by Buildings.tsx instead.
 *
 * Everything here is a pure function of { layout, changeSet } — the compare
 * view must never shift the underlying layout (PRD risk §11), only decorate
 * it.
 */

import { useMemo, useRef } from "react";
import type { Group } from "three";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";

import type { CityLayout, District } from "@/lib/city/layout";
import type { ChangeSet } from "@/lib/diff/apply";
import { parentDistrict } from "@/lib/diff/apply";
import { STATUS_COLORS } from "./Buildings";

/** Fixed rubble footprint/height — rubble is metaphor, not measurement. */
const RUBBLE_W = 6;
const RUBBLE_D = 6;
const RUBBLE_H = 0.7;
/** Foundation slabs: taller than rubble but clearly not a building (Phase 5). */
const FOUNDATION_W = 6;
const FOUNDATION_D = 6;
const FOUNDATION_H = 0.9;
/** Deterministic per-file offset inside the parent district (world units). */
const RUBBLE_SLOT_GAP = 2.4;

/**
 * Deterministic slot for a position-less file (rubble / rename origin):
 * its parent district's center plus a stable wedge offset derived from the
 * path hash so debris never stacks on the district label.
 */
function slotFor(district: District, path: string, index: number): { x: number; z: number } {
  const hash = [...path].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7);
  const angle = ((hash >>> 8) % 628) / 100; // 0..2π
  const radius = RUBBLE_SLOT_GAP * (1 + (index % 3));
  return { x: district.x + Math.cos(angle) * radius, z: district.z + Math.sin(angle) * radius };
}

export function ChangeOverlays({ layout, changeSet }: { layout: CityLayout; changeSet: ChangeSet }) {
  const districtIndex = useMemo(
    () => new Map(layout.districts.map((district) => [district.path, district])),
    [layout],
  );

  const rubble = useMemo(() => {
    return changeSet.changes
      .filter((change) => change.status === "rubble")
      .map((change, index) => {
        const district = districtIndex.get(
          parentDistrict(layout.districts, change.fileId)?.path ?? "",
        );
        if (district === undefined) return null;
        const slot = slotFor(district, change.fileId, index);
        return { id: change.fileId, ...slot };
      });
  }, [changeSet, districtIndex, layout.districts]);

  /**
   * Foundation-status files that have no building in the captured layout
   * (created after the city was built): a low pale slab at their parent
   * district slot. Files that DO have a building are flattened by
   * Buildings.tsx directly — no extra mesh here.
   */
  const foundations = useMemo(() => {
    const buildingIds = new Set(layout.buildings.map((building) => building.fileId));
    return changeSet.changes
      .filter((change) => change.status === "foundation" && !buildingIds.has(change.fileId))
      .map((change, index) => {
        const district = districtIndex.get(
          parentDistrict(layout.districts, change.fileId)?.path ?? "",
        );
        if (district === undefined) return null;
        const slot = slotFor(district, change.fileId, index);
        return { id: change.fileId, ...slot };
      });
  }, [changeSet, districtIndex, layout]);

  const movedLine = useMemo(() => {
    const from = changeSet.changes.find((change) => change.status === "moved");
    if (from === undefined || from.oldPath === undefined) return null;
    const target = layout.buildings.find((building) => building.fileId === from.fileId);
    const oldDistrict = districtIndex.get(parentDistrict(layout.districts, from.oldPath)?.path ?? "");
    if (target === undefined || oldDistrict === undefined) return null;
    const origin = slotFor(oldDistrict, from.oldPath, 0);
    return { points: [[origin.x, 0.4, origin.z], [target.x, 0.4, target.z]] as [number, number, number][] };
  }, [changeSet, districtIndex, layout]);

  return (
    <group>
      {rubble.map((slab) =>
        slab === null ? null : (
          <mesh key={`rubble:${slab.id}`} position={[slab.x, RUBBLE_H / 2, slab.z]}>
            <boxGeometry args={[RUBBLE_W, RUBBLE_H, RUBBLE_D]} />
            <meshStandardMaterial color={STATUS_COLORS.rubble} roughness={1} metalness={0} />
          </mesh>
        ),
      )}

      {foundations.map((slab) =>
        slab === null ? null : (
          <mesh key={`foundation:${slab.id}`} position={[slab.x, FOUNDATION_H / 2, slab.z]}>
            <boxGeometry args={[FOUNDATION_W, FOUNDATION_H, FOUNDATION_D]} />
            <meshStandardMaterial color={STATUS_COLORS.foundation} roughness={1} metalness={0} />
          </mesh>
        ),
      )}

      {layout.buildings
        .filter((building) => changeSet.changes.find((change) => change.fileId === building.fileId)?.status === "construction")
        .map((building) => (
          <CraneMarker
            key={`crane:${building.fileId}`}
            x={building.x}
            z={building.z}
            top={building.h}
          />
        ))}

      {movedLine && <Line points={movedLine.points} color={STATUS_COLORS.moved} lineWidth={3} />}
    </group>
  );
}

/**
 * The animated crane: an amber mast on the roof plus a jib arm rotating
 * slowly around it. Uses useFrame — the only animated element in the whole
 * scene (same reasoning as the Phase 0 spike cube: cheap,clear metaphor).
 */
function CraneMarker({ x, z, top }: { x: number; z: number; top: number }) {
  const jib = useRef<Group>(null);
  useFrame((_, delta) => {
    if (jib.current !== null) {
      jib.current.rotation.y += delta * 0.6;
    }
  });

  return (
    <group position={[x, top, z]}>
      {/* Mast */}
      <mesh position={[0, 2.2, 0]}>
        <boxGeometry args={[0.5, 4.4, 0.5]} />
        <meshStandardMaterial color={STATUS_COLORS.construction} roughness={0.6} metalness={0.2} />
      </mesh>
      {/* Rotating jib */}
      <group ref={jib} position={[0, 4.2, 0]}>
        <mesh position={[2, 0, 0]}>
          <boxGeometry args={[4, 0.35, 0.35]} />
          <meshStandardMaterial color={STATUS_COLORS.construction} roughness={0.6} metalness={0.2} />
        </mesh>
      </group>
    </group>
  );
}
