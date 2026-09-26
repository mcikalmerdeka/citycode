"use client";

/**
 * ChangeOverlays — the compare-only ground/feature treatments that have no
 * counterpart in the static view. Everything here is a pure function of
 * { layout, changeSet } — the compare view must never shift the underlying
 * layout (PRD risk §11), only decorate it.
 *
 * Small World diorama restyle (Unit B): mechanics unchanged, palette moved
 * to the warm diorama tokens from COMPARE_ACCENTS / theme.ts —
 * - Construction cranes (modified): a proper tower crane — tapered mast with
 *   cross-brace hints, jib + counter-jib + counterweight, a trolley that
 *   slowly travels the jib with a hanging cable and hook, and an amber
 *   beacon that blinks on top. Per-crane phase (fileId hash) desynchronizes
 *   a skyline of cranes. Slow jib rotation kept from the original marker.
 *   Crane structure is now warm construction-amber over dark timber steel.
 * - Fresh buildings (added): the rise-from-foundation animation lives in
 *   Buildings.tsx (it animates the actual instanced matrices); documented
 *   here so the split is discoverable.
 * - Rubble (deleted): a cluster of 4–7 tilted chunks per deleted file,
 *   deterministic via the same path-hash family as {@link slotFor} — the
 *   same commit always renders the same wreckage. Chunks are warm rubble
 *   grey over a pale disturbed-earth scar (no near-black).
 * - Blast radius: roof tinting stays in Buildings; each blast building
 *   additionally gets a slow ground shockwave ring (staggered phase, subtle)
 *   in the muted terracotta-red blast accent.
 * - Moved (renamed): ALL renames draw a slate-blue line (the old renderer
 *   showed only the first), with a marching-ants dash flow toward the new
 *   location.
 * - Foundation slabs: pale diorama cream (COMPARE_ACCENTS.foundation).
 * - prefers-reduced-motion freezes every loop here (static emphasis kept).
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ComponentRef } from "react";
import { Line } from "@react-three/drei";

import type { CityLayout, District } from "@/lib/city/layout";
import type { ChangeSet, NodeChange } from "@/lib/diff/apply";
import { COMPARE_ACCENTS } from "@/lib/city/theme";
import { parentDistrict } from "@/lib/diff/apply";

/** Foundation slabs: taller than rubble but clearly not a building (Phase 5). */
const FOUNDATION_W = 6;
const FOUNDATION_D = 6;
const FOUNDATION_H = 0.9;
/** Deterministic per-file offset inside the parent district (world units). */
const RUBBLE_SLOT_GAP = 2.4;

/** Crane palette — warm construction amber over dark timber steel. */
const CRANE_AMBER = COMPARE_ACCENTS.construction;
const CRANE_STEEL = "#4A4038";
const CRANE_COUNTERWEIGHT = "#3A332C";
const CRANE_CABLE = "#332D27";
/** Rubble: warm grey chunks over a pale disturbed-earth scar. */
const RUBBLE_CHUNK = COMPARE_ACCENTS.rubble;
const RUBBLE_SCAR = "#C9BFAE";

/** Stable 32-bit path hash — the only "randomness" source for chunk scatter. */
function hashOf(value: string): number {
  let hash = 7;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** Shared reduced-motion probe (duplicated per file — no new shared module). */
function usePrefersReducedMotion(): { current: boolean } {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  return ref;
}

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

/** One rubble chunk: local offset, size, and tilt — all hash-derived. */
interface RubbleChunk {
  x: number;
  z: number;
  size: number;
  h: number;
  rotY: number;
  tilt: number;
}

/**
 * 4–7 wreckage chunks for one deleted file. An LCG seeded from the path hash
 * keeps the scatter deterministic — same commit, same wreckage, always.
 */
function rubbleChunksFor(fileId: string): RubbleChunk[] {
  let state = hashOf(fileId);
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const count = 4 + (hashOf(fileId) % 4);
  const chunks: RubbleChunk[] = [];
  for (let i = 0; i < count; i++) {
    const angle = next() * Math.PI * 2;
    const radius = 0.5 + next() * 2.1;
    chunks.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      size: 0.7 + next() * 1.4,
      h: 0.35 + next() * 0.75,
      rotY: next() * Math.PI,
      tilt: (next() - 0.5) * 0.55,
    });
  }
  return chunks;
}

/**
 * The tower crane: tapered mast + cross-braces, rotating jib assembly with
 * counter-jib and counterweight, a trolley traveling the jib with cable and
 * hook, and a blinking amber beacon. Only transforms animate; geometry and
 * materials are static per crane.
 */
function CraneMarker({
  x,
  z,
  top,
  fileId,
  reducedMotion,
}: {
  x: number;
  z: number;
  top: number;
  fileId: string;
  reducedMotion: { current: boolean };
}) {
  const phase = useMemo(() => (hashOf(fileId) % 628) / 100, [fileId]);
  const jibRef = useRef<THREE.Group>(null);
  const trolleyRef = useRef<THREE.Group>(null);
  const beaconRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (reducedMotion.current) return;
    const t = clock.elapsedTime + phase;
    if (jibRef.current !== null) jibRef.current.rotation.y = t * 0.35;
    if (trolleyRef.current !== null) {
      trolleyRef.current.position.x = 3.1 + Math.sin(t * 0.5) * 1.6;
    }
    if (beaconRef.current !== null) {
      beaconRef.current.emissiveIntensity =
        0.3 + Math.pow(Math.max(0, Math.sin(t * 3.2)), 6) * 2.6;
    }
  });

  const amber = CRANE_AMBER;
  return (
    <group position={[x, top, z]}>
      {/* Concrete base */}
      <mesh position={[0, 0.25, 0]}>
        <boxGeometry args={[1.1, 0.5, 1.1]} />
        <meshStandardMaterial color={CRANE_COUNTERWEIGHT} roughness={0.95} metalness={0} />
      </mesh>
      {/* Tapered mast + cross-brace hints */}
      {[0, 1, 2].map((level) => (
        <group key={level}>
          <mesh position={[0, 1.3 + level * 1.55, 0]}>
            <boxGeometry args={[0.55 - level * 0.07, 1.6, 0.55 - level * 0.07]} />
            <meshStandardMaterial color={amber} roughness={0.6} metalness={0.2} />
          </mesh>
          <mesh position={[0.24, 1.3 + level * 1.55, 0]} rotation-z={0.55}>
            <boxGeometry args={[0.07, 1.15, 0.07]} />
            <meshStandardMaterial color={CRANE_STEEL} roughness={0.7} metalness={0.3} />
          </mesh>
          <mesh position={[0, 1.3 + level * 1.55, 0.24]} rotation-x={-0.55}>
            <boxGeometry args={[0.07, 1.15, 0.07]} />
            <meshStandardMaterial color={CRANE_STEEL} roughness={0.7} metalness={0.3} />
          </mesh>
        </group>
      ))}
      {/* Rotating jib assembly */}
      <group ref={jibRef} position={[0, 5.3, 0]}>
        {/* Apex tower + beacon */}
        <mesh position={[0, 0.6, 0]}>
          <boxGeometry args={[0.3, 1.2, 0.3]} />
          <meshStandardMaterial color={amber} roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[0, 1.35, 0]}>
          <sphereGeometry args={[0.16, 10, 10]} />
          <meshStandardMaterial
            ref={beaconRef}
            color="#1a1508"
            emissive={amber}
            emissiveIntensity={0.3}
            roughness={0.4}
            metalness={0}
          />
        </mesh>
        {/* Jib + counter-jib + counterweight */}
        <mesh position={[2.0, 0, 0]}>
          <boxGeometry args={[5.2, 0.28, 0.28]} />
          <meshStandardMaterial color={amber} roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[-1.7, 0, 0]}>
          <boxGeometry args={[2.2, 0.28, 0.28]} />
          <meshStandardMaterial color={amber} roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[-2.6, -0.35, 0]}>
          <boxGeometry args={[0.8, 0.7, 0.7]} />
          <meshStandardMaterial color={CRANE_COUNTERWEIGHT} roughness={0.9} metalness={0.1} />
        </mesh>
        {/* Traveling trolley with cable + hook */}
        <group ref={trolleyRef} position={[3.1, -0.25, 0]}>
          <mesh>
            <boxGeometry args={[0.4, 0.22, 0.4]} />
            <meshStandardMaterial color={CRANE_STEEL} roughness={0.7} metalness={0.3} />
          </mesh>
          <mesh position={[0, -0.75, 0]}>
            <boxGeometry args={[0.05, 1.3, 0.05]} />
            <meshStandardMaterial color={CRANE_CABLE} roughness={0.8} metalness={0.2} />
          </mesh>
          <mesh position={[0, -1.45, 0]}>
            <boxGeometry args={[0.18, 0.18, 0.18]} />
            <meshStandardMaterial color={amber} roughness={0.6} metalness={0.2} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** Slow ground shockwave under a blast-radius building (staggered phase). */
function BlastRing({
  x,
  z,
  base,
  phase,
  reducedMotion,
}: {
  x: number;
  z: number;
  base: number;
  phase: number;
  reducedMotion: { current: boolean };
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    const material = materialRef.current;
    if (mesh === null || material === null) return;
    if (reducedMotion.current) {
      mesh.scale.set(base * 1.4, base * 1.4, 1);
      material.opacity = 0.25;
      return;
    }
    const progress = (((clock.elapsedTime * 0.45 + phase) % 1) + 1) % 1;
    const scale = base * (1 + progress * 1.8);
    mesh.scale.set(scale, scale, 1);
    material.opacity = (1 - progress) * 0.5;
  });

  return (
    <mesh ref={meshRef} position={[x, 0.33, z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.85, 1, 40]} />
      <meshBasicMaterial
        ref={materialRef}
        color={COMPARE_ACCENTS.blast}
        transparent
        opacity={0.5}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/** Cyan rename line with a marching-ants dash flow toward the new spot. */
function MovedLine({
  points,
  reducedMotion,
}: {
  points: [number, number, number][];
  reducedMotion: { current: boolean };
}) {
  const lineRef = useRef<ComponentRef<typeof Line> | null>(null);
  useFrame((_, delta) => {
    if (reducedMotion.current) return;
    const line = lineRef.current;
    if (line !== null) {
      (line.material as { dashOffset: number }).dashOffset -= delta * 3;
    }
  });
  return (
    <Line
      ref={lineRef}
      points={points}
      color={COMPARE_ACCENTS.moved}
      lineWidth={3}
      dashed
      dashSize={1.4}
      gapSize={0.9}
    />
  );
}

export function ChangeOverlays({ layout, changeSet }: { layout: CityLayout; changeSet: ChangeSet }) {
  const reducedMotion = usePrefersReducedMotion();

  const districtIndex = useMemo(
    () => new Map(layout.districts.map((district) => [district.path, district])),
    [layout],
  );

  const changeIndex = useMemo(
    () => new Map(changeSet.changes.map((change) => [change.fileId, change])),
    [changeSet],
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
        return { id: change.fileId, ...slot, chunks: rubbleChunksFor(change.fileId) };
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

  const cranes = useMemo(
    () =>
      layout.buildings.filter(
        (building) => changeIndex.get(building.fileId)?.status === "construction",
      ),
    [layout.buildings, changeIndex],
  );

  const blastBuildings = useMemo(
    () =>
      layout.buildings.filter(
        (building) => changeIndex.get(building.fileId)?.status === "blast",
      ),
    [layout.buildings, changeIndex],
  );

  const movedLines = useMemo(() => {
    return changeSet.changes
      .filter(
        (change): change is NodeChange & { oldPath: string } =>
          change.status === "moved" && change.oldPath !== undefined,
      )
      .map((change) => {
        const target = layout.buildings.find((building) => building.fileId === change.fileId);
        const oldDistrict = districtIndex.get(
          parentDistrict(layout.districts, change.oldPath)?.path ?? "",
        );
        if (target === undefined || oldDistrict === undefined) return null;
        const origin = slotFor(oldDistrict, change.oldPath, 0);
        return {
          id: change.fileId,
          points: [
            [origin.x, 0.45, origin.z],
            [target.x, 0.45, target.z],
          ] as [number, number, number][],
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
  }, [changeSet, districtIndex, layout]);

  // Shared rubble geometry/material — one unit box + one grey for all chunks.
  const rubbleShared = useMemo(
    () => ({
      geometry: new THREE.BoxGeometry(1, 1, 1),
      material: new THREE.MeshStandardMaterial({
        color: RUBBLE_CHUNK,
        roughness: 1,
        metalness: 0,
      }),
    }),
    [],
  );
  useEffect(
    () => () => {
      rubbleShared.geometry.dispose();
      rubbleShared.material.dispose();
    },
    [rubbleShared],
  );

  return (
    <group>
      {rubble.map((slab) =>
        slab === null ? null : (
          <group key={`rubble:${slab.id}`} position={[slab.x, 0, slab.z]}>
            {slab.chunks.map((chunk, index) => (
              <mesh
                key={index}
                position={[chunk.x, chunk.h / 2, chunk.z]}
                rotation={[chunk.tilt, chunk.rotY, chunk.tilt * 0.7]}
                scale={[chunk.size, chunk.h, chunk.size]}
                geometry={rubbleShared.geometry}
                material={rubbleShared.material}
                dispose={null}
              />
            ))}
            {/* Ground scar under the wreckage so the plot reads as disturbed. */}
            <mesh position={[0, 0.05, 0]}>
              <boxGeometry args={[5.4, 0.1, 5.4]} />
              <meshStandardMaterial color={RUBBLE_SCAR} roughness={1} metalness={0} />
            </mesh>
          </group>
        ),
      )}

      {foundations.map((slab) =>
        slab === null ? null : (
          <mesh key={`foundation:${slab.id}`} position={[slab.x, FOUNDATION_H / 2, slab.z]}>
            <boxGeometry args={[FOUNDATION_W, FOUNDATION_H, FOUNDATION_D]} />
            <meshStandardMaterial color={COMPARE_ACCENTS.foundation} roughness={1} metalness={0} />
          </mesh>
        ),
      )}

      {cranes.map((building) => (
        <CraneMarker
          key={`crane:${building.fileId}`}
          x={building.x}
          z={building.z}
          top={building.h}
          fileId={building.fileId}
          reducedMotion={reducedMotion}
        />
      ))}

      {blastBuildings.map((building) => (
        <BlastRing
          key={`blast:${building.fileId}`}
          x={building.x}
          z={building.z}
          base={Math.max(building.w, building.d) * 0.9}
          phase={(hashOf(building.fileId) % 100) / 100}
          reducedMotion={reducedMotion}
        />
      ))}

      {movedLines.map((line) => (
        <MovedLine key={`moved:${line.id}`} points={line.points} reducedMotion={reducedMotion} />
      ))}
    </group>
  );
}
