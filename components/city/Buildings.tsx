"use client";

/**
 * Buildings — the Small World storybook-town renderer.
 *
 * One instanced wall mesh per shape variant, plus instanced roof meshes per
 * roof kind (gable prisms, hip pyramids, flat tower caps), rooftop solar
 * panels, brick chimneys and shop awnings. Style choices live in
 * buildingStyle.ts; this file owns instancing, interaction and animation.
 *
 * Rules preserved from the previous renderer:
 * - Compare status NEVER recolors walls — it tints roofs (via compareAccent)
 *   plus a thin base ring for construction/rubble.
 * - Hover: warm brightness lift; selection: pulsing warm emissive overlay.
 * - Fresh buildings rise from foundation height once over RISE_DURATION.
 * - LOD: past LOD_DETAIL_THRESHOLD the window shader switches off; past
 *   LOD_SHADOW_THRESHOLD buildings no longer cast shadows.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Instance, Instances, Outlines } from "@react-three/drei";

import type { Building } from "@/lib/city/layout";
import type { NodeChange, NodeStatus } from "@/lib/diff/apply";
import { BUILDING_COLORS, COMPARE_ACCENTS } from "@/lib/city/theme";
import { useCityStore } from "@/lib/store";
import { compareAccent, roofRidgeOrientation } from "./compareAccent";
import {
  CAP_OVERHANG,
  ROOF_OVERHANG,
  buildGableGeometry,
  buildHipGeometry,
  buildSlabGeometry,
  buildVariantGeometries,
  hashCode,
  injectWindows,
  roofColorFor,
  roofKindFor,
  roofRiseFor,
  variantFor,
  wallColorFor,
  type EnvParams,
  type RoofKind,
  type Variant,
} from "./buildingStyle";

export type { EnvParams } from "./buildingStyle";

const DEFAULT_ENV: EnvParams = {
  night: 0,
  dusk: 0,
  lightsOn: 0,
  rain: 0,
  cloud: 0,
  wind: 0,
  wet: 0,
};

const HOVER_EMISSIVE = "#f5ead6";
const SELECTED_EMISSIVE = "#e4a33c";
const SELECTION_SCALE = 1.02;

/**
 * Compare-status accents for the base ring. Exported because FileTree.tsx
 * and Legend.tsx mirror these status colors.
 */
export const STATUS_COLORS: Record<NodeStatus, string> = {
  construction: COMPARE_ACCENTS.construction,
  fresh: COMPARE_ACCENTS.fresh,
  foundation: COMPARE_ACCENTS.foundation,
  rubble: COMPARE_ACCENTS.rubble,
  moved: COMPARE_ACCENTS.moved,
  blast: COMPARE_ACCENTS.blast,
};

const FOUNDATION_H = 0.9;
const LOD_DETAIL_THRESHOLD = 400;
const LOD_SHADOW_THRESHOLD = 900;
const RISE_DURATION = 1.5;
const PULSE_SPEED = 2.4;
const PULSE_AMPLITUDE = 0.3;
const PULSE_BASE = 0.55;

const ROOF_KINDS: readonly RoofKind[] = ["gable", "hip", "flat"];

/** A box-shaped detail instance (chimney, solar panel, awning). */
interface DetailBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

interface RoofInstance {
  fileId: string;
  kind: RoofKind;
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
  rise: number;
  rotate: boolean;
  color: string;
}

interface RiseAnim {
  fileId: string;
  group: Variant;
  index: number;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const tmpColor = new THREE.Color();

/**
 * Compose one roof matrix. Scale is local (T·R·S), so a 90°-rotated gable
 * swaps its x/z scale or the footprint comes out transposed.
 */
function composeRoofMatrix(roof: RoofInstance, y: number): void {
  const over = roof.kind === "flat" ? CAP_OVERHANG : ROOF_OVERHANG;
  const w = roof.w * over;
  const d = roof.d * over;
  tmpMatrix.compose(
    tmpPosition.set(roof.x, y, roof.z),
    tmpQuaternion.setFromEuler(tmpEuler.set(0, roof.rotate ? Math.PI / 2 : 0, 0)),
    tmpScale.set(roof.rotate ? d : w, roof.rise, roof.rotate ? w : d),
  );
}

/** Pure derivation of every roof-level detail box for the current city. */
function deriveDetails(
  buildings: Building[],
  changes: Map<string, NodeChange> | undefined,
): { chimneys: DetailBox[]; solar: DetailBox[]; awnings: DetailBox[] } {
  const chimneys: DetailBox[] = [];
  const solar: DetailBox[] = [];
  const awnings: DetailBox[] = [];
  for (const b of buildings) {
    if (changes?.get(b.fileId)?.status === "foundation") continue;
    const hash = hashCode(b.fileId);
    const kind = roofKindFor(b);
    const rise = roofRiseFor(b);
    const min = Math.min(b.w, b.d);
    if (kind === "flat") {
      // Solar array on most tower roofs, offset toward one corner.
      if (hash % 4 !== 0) {
        solar.push({
          x: b.x - b.w * 0.12,
          y: b.h + rise,
          z: b.z + b.d * 0.1,
          w: b.w * 0.5,
          h: 0.22,
          d: b.d * 0.42,
          color: BUILDING_COLORS.solarPanel,
        });
      }
      // Stair/lift housing box.
      chimneys.push({
        x: b.x + b.w * 0.28,
        y: b.h + rise,
        z: b.z - b.d * 0.26,
        w: min * 0.2,
        h: 1.1,
        d: min * 0.2,
        color: BUILDING_COLORS.towerRoof,
      });
      continue;
    }
    if (hash % 9 < 4) {
      const rotate = roofRidgeOrientation(b.fileId) === "z";
      const along = (((hash >>> 5) % 100) / 100 - 0.5) * 0.6;
      const ridge = rotate ? b.d : b.w;
      const side = min * (0.1 + ((hash >>> 7) % 10) / 250);
      chimneys.push({
        x: b.x + (rotate ? 0 : along * ridge * 0.5),
        y: b.h + rise * 0.35,
        z: b.z + (rotate ? along * ridge * 0.5 : 0),
        w: side,
        h: Math.min(2.6, rise * 0.9 + 0.6),
        d: side,
        color: BUILDING_COLORS.redbrick,
      });
    }
    // Townhouses get a colored shop awning wrapping the ground floor.
    if (variantFor(b) === 1 && b.h > 3) {
      awnings.push({
        x: b.x,
        y: 1.15,
        z: b.z,
        w: b.w * 1.07,
        h: 0.32,
        d: b.d * 1.07,
        color: roofColorFor(b),
      });
    }
  }
  return { chimneys, solar, awnings };
}

export function Buildings({
  buildings,
  changes,
  envParams,
}: {
  buildings: Building[];
  changes?: Map<string, NodeChange>;
  /** Scene environment uniforms; defaults render a neutral daytime town. */
  envParams?: EnvParams;
}) {
  const env = envParams ?? DEFAULT_ENV;
  const select = useCityStore((state) => state.select);
  const selectedId = useCityStore((state) => state.selectedId);
  const setHovered = useCityStore((state) => state.setHovered);
  const requestFocus = useCityStore((state) => state.requestFocus);

  const detailed = buildings.length <= LOD_DETAIL_THRESHOLD;
  const castShadow = buildings.length <= LOD_SHADOW_THRESHOLD;

  const heightFor = useCallback(
    (building: Building): number =>
      changes?.get(building.fileId)?.status === "foundation"
        ? Math.min(building.h, FOUNDATION_H)
        : building.h,
    [changes],
  );

  const byId = useMemo(
    () => new Map(buildings.map((building) => [building.fileId, building])),
    [buildings],
  );
  const selected = selectedId === null ? null : (byId.get(selectedId) ?? null);

  const groups = useMemo<[Building[], Building[], Building[]]>(() => {
    const result: [Building[], Building[], Building[]] = [[], [], []];
    for (const building of buildings) result[variantFor(building)].push(building);
    return result;
  }, [buildings]);

  const geometries = useMemo(() => buildVariantGeometries(), []);
  useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries]);

  const roofGeometries = useMemo<Record<RoofKind, THREE.BufferGeometry>>(
    () => ({ gable: buildGableGeometry(), hip: buildHipGeometry(), flat: buildSlabGeometry() }),
    [],
  );
  const slabGeometry = useMemo(() => buildSlabGeometry(), []);
  useEffect(
    () => () => {
      Object.values(roofGeometries).forEach((geometry) => geometry.dispose());
      slabGeometry.dispose();
    },
    [roofGeometries, slabGeometry],
  );

  /** Roofs per kind; foundations get none (they are not-yet-buildings). */
  const roofsByKind = useMemo<Record<RoofKind, RoofInstance[]>>(() => {
    const result: Record<RoofKind, RoofInstance[]> = { gable: [], hip: [], flat: [] };
    const mode = useCityStore.getState().compareMode;
    for (const b of buildings) {
      const status = changes?.get(b.fileId)?.status;
      if (status === "foundation") continue;
      const kind = roofKindFor(b);
      result[kind].push({
        fileId: b.fileId,
        kind,
        x: b.x,
        z: b.z,
        w: b.w,
        d: b.d,
        y: heightFor(b),
        rise: roofRiseFor(b),
        rotate: kind === "gable" && roofRidgeOrientation(b.fileId) === "z",
        color: compareAccent(mode, status ?? "").roofTint ?? roofColorFor(b),
      });
    }
    return result;
    // compareMode is read via getState(); a mode switch re-renders the scene.
  }, [buildings, changes, heightFor]);

  const details = useMemo(() => deriveDetails(buildings, changes), [buildings, changes]);

  const riseAnims = useMemo<RiseAnim[]>(() => {
    const anims: RiseAnim[] = [];
    groups.forEach((list, group) => {
      list.forEach((b, index) => {
        if (changes?.get(b.fileId)?.status !== "fresh") return;
        anims.push({ fileId: b.fileId, group: group as Variant, index, x: b.x, z: b.z, w: b.w, d: b.d, h: b.h });
      });
    });
    return anims;
  }, [groups, changes]);

  const groupRefs = useRef<(THREE.InstancedMesh | null)[]>([null, null, null]);
  const roofRefs = useRef<Record<RoofKind, THREE.InstancedMesh | null>>({ gable: null, hip: null, flat: null });
  const setRoofMesh = useCallback((kind: RoofKind, mesh: THREE.InstancedMesh | null) => {
    roofRefs.current[kind] = mesh;
  }, []);
  const riseStart = useRef<number | null>(null);
  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const hoverRef = useRef<THREE.Mesh>(null);
  const selectionMaterialRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (riseAnims.length > 0 && !reducedMotion.current) {
      if (riseStart.current === null) riseStart.current = clock.elapsedTime;
      const t = clock.elapsedTime - riseStart.current;
      if (t <= RISE_DURATION + 0.05) {
        const eased = 1 - Math.pow(1 - Math.min(1, t / RISE_DURATION), 3);
        for (const anim of riseAnims) {
          const mesh = groupRefs.current[anim.group];
          if (mesh === null) continue;
          const hNow = THREE.MathUtils.lerp(FOUNDATION_H, anim.h, eased);
          tmpMatrix.compose(
            tmpPosition.set(anim.x, 0, anim.z),
            tmpQuaternion.identity(),
            tmpScale.set(anim.w, hNow, anim.d),
          );
          mesh.setMatrixAt(anim.index, tmpMatrix);
          mesh.instanceMatrix.needsUpdate = true;
          for (const kind of ROOF_KINDS) {
            const roofMesh = roofRefs.current[kind];
            const index = roofsByKind[kind].findIndex((roof) => roof.fileId === anim.fileId);
            if (roofMesh === null || index < 0) continue;
            composeRoofMatrix(roofsByKind[kind][index], hNow);
            roofMesh.setMatrixAt(index, tmpMatrix);
            roofMesh.instanceMatrix.needsUpdate = true;
          }
        }
      }
    }

    const hoverMesh = hoverRef.current;
    if (hoverMesh !== null) {
      const hoveredId = useCityStore.getState().hoveredId;
      const hovered = hoveredId === null ? undefined : byId.get(hoveredId);
      if (hovered === undefined) {
        hoverMesh.visible = false;
      } else {
        const h = heightFor(hovered) * SELECTION_SCALE;
        hoverMesh.visible = true;
        hoverMesh.position.set(hovered.x, h / 2, hovered.z);
        hoverMesh.scale.set(hovered.w * SELECTION_SCALE, h, hovered.d * SELECTION_SCALE);
      }
    }

    if (!reducedMotion.current && selectionMaterialRef.current !== null) {
      const wave = Math.sin(clock.elapsedTime * PULSE_SPEED);
      selectionMaterialRef.current.emissiveIntensity = PULSE_BASE + PULSE_AMPLITUDE * wave;
    }
  });

  return (
    <group>
      {groups.map((list, variant) =>
        list.length === 0 ? null : (
          <Instances
            key={variant}
            limit={list.length}
            range={list.length}
            castShadow={castShadow}
            receiveShadow
            ref={(mesh: THREE.InstancedMesh | null) => {
              groupRefs.current[variant] = mesh;
            }}
          >
            <primitive object={geometries[variant]} attach="geometry" />
            <meshStandardMaterial
              roughness={0.88}
              metalness={0}
              onBeforeCompile={detailed ? (shader) => injectWindows(shader, env) : undefined}
            />
            {list.map((building) => (
              <Instance
                key={building.fileId}
                color={wallColorFor(building)}
                position={[building.x, 0, building.z]}
                scale={[building.w, heightFor(building), building.d]}
                onClick={(event: ThreeEvent<MouseEvent>) => {
                  event.stopPropagation();
                  select(building.fileId);
                  requestFocus(building.fileId);
                }}
                onPointerOver={(event: ThreeEvent<PointerEvent>) => {
                  event.stopPropagation();
                  setHovered(building.fileId);
                  document.body.style.cursor = "pointer";
                }}
                onPointerOut={() => {
                  setHovered(null);
                  document.body.style.cursor = "auto";
                }}
              />
            ))}
          </Instances>
        ),
      )}

      {ROOF_KINDS.map((kind) =>
        roofsByKind[kind].length === 0 ? null : (
          <RoofMesh
            key={`${kind}:${roofsByKind[kind].length}`}
            roofs={roofsByKind[kind]}
            geometry={roofGeometries[kind]}
            castShadow={castShadow}
            kind={kind}
            onMesh={setRoofMesh}
          />
        ),
      )}

      <DetailMesh boxes={details.chimneys} geometry={slabGeometry} castShadow={castShadow} roughness={0.9} />
      <DetailMesh boxes={details.solar} geometry={slabGeometry} castShadow={false} roughness={0.35} metalness={0.3} />
      <DetailMesh boxes={details.awnings} geometry={slabGeometry} castShadow={castShadow} roughness={0.8} />

      {buildings.map((building) => {
        const status = changes?.get(building.fileId)?.status;
        const accent = compareAccent(useCityStore.getState().compareMode, status ?? "");
        if (accent.outline === undefined) return null;
        return (
          <BaseRing
            key={`ring:${building.fileId}`}
            x={building.x}
            z={building.z}
            w={building.w}
            d={building.d}
            color={accent.outline}
          />
        );
      })}

      <mesh ref={hoverRef} visible={false}>
        <boxGeometry />
        <meshStandardMaterial
          color={BUILDING_COLORS.wallCream}
          emissive={HOVER_EMISSIVE}
          emissiveIntensity={0.35}
          transparent
          opacity={detailed ? 0.28 : 0}
          depthWrite={false}
          roughness={0.92}
          metalness={0}
        />
        <Outlines thickness={0.03} color="#f0e8da" opacity={0.9} transparent />
      </mesh>

      {selected && (
        <mesh
          position={[selected.x, (heightFor(selected) * SELECTION_SCALE) / 2, selected.z]}
          scale={[
            selected.w * SELECTION_SCALE,
            heightFor(selected) * SELECTION_SCALE,
            selected.d * SELECTION_SCALE,
          ]}
        >
          <boxGeometry />
          <meshStandardMaterial
            ref={selectionMaterialRef}
            color={BUILDING_COLORS.wallCream}
            emissive={SELECTED_EMISSIVE}
            emissiveIntensity={PULSE_BASE}
            roughness={0.92}
            metalness={0}
          />
        </mesh>
      )}
    </group>
  );
}

/** One instanced roof mesh; matrices + colors written once per roof list. */
function RoofMesh({
  roofs,
  geometry,
  castShadow,
  kind,
  onMesh,
}: {
  roofs: RoofInstance[];
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
  kind: RoofKind;
  onMesh: (kind: RoofKind, mesh: THREE.InstancedMesh | null) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    onMesh(kind, mesh);
    if (mesh === null) return;
    roofs.forEach((roof, index) => {
      composeRoofMatrix(roof, roof.y);
      mesh.setMatrixAt(index, tmpMatrix);
      mesh.setColorAt(index, tmpColor.set(roof.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    return () => onMesh(kind, null);
  }, [roofs, kind, onMesh]);
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, undefined, roofs.length]}
      castShadow={castShadow}
      receiveShadow
      dispose={null}
    >
      <meshStandardMaterial roughness={0.82} metalness={0} flatShading />
    </instancedMesh>
  );
}

/** Instanced base-anchored boxes (chimneys, solar panels, awnings). */
function DetailMesh({
  boxes,
  geometry,
  castShadow,
  roughness,
  metalness = 0,
}: {
  boxes: DetailBox[];
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
  roughness: number;
  metalness?: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = ref.current;
    if (mesh === null) return;
    boxes.forEach((box, index) => {
      tmpMatrix.compose(
        tmpPosition.set(box.x, box.y, box.z),
        tmpQuaternion.identity(),
        tmpScale.set(box.w, box.h, box.d),
      );
      mesh.setMatrixAt(index, tmpMatrix);
      mesh.setColorAt(index, tmpColor.set(box.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [boxes]);
  if (boxes.length === 0) return null;
  return (
    <instancedMesh
      key={boxes.length}
      ref={ref}
      args={[geometry, undefined, boxes.length]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled={false}
      dispose={null}
    >
      <meshStandardMaterial roughness={roughness} metalness={metalness} />
    </instancedMesh>
  );
}

/** Thin emissive ring at a building's base — compare-status ground emphasis. */
function BaseRing({ x, z, w, d, color }: { x: number; z: number; w: number; d: number; color: string }) {
  return (
    <mesh position={[x, 0.12, z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[Math.max(w, d) * 0.62, Math.max(w, d) * 0.72, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}
