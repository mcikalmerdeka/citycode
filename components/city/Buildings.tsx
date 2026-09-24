"use client";

/**
 * Buildings — one instanced mesh per {@link Building}, grouped into a small
 * deterministic shape vocabulary, plus overlay meshes for hover/selection.
 *
 * Rules encoded here (PRD visual contract):
 * - Static view: ONE uniform color for every building. Hue is reserved for
 *   compare modes; per-building color variation is forbidden there.
 * - Compare view (Phase 4): per-instance colors by change status — orange
 *   construction sites, lime fresh builds, red blast-radius tint. Phase 5
 *   adds the "foundation" treatment: untracked files flatten into low pale
 *   slabs (same property, same rules). A change status and the selection
 *   may co-exist: the status recolors the instance while selection stays
 *   the ×1.02 emissive overlay (never two colors on the same property —
 *   selection never carries hue, only glow).
 *
 * Phase 3D building strategy ("one visual system, rich form"):
 * - Shape vocabulary: three variants picked deterministically by height tier
 *   + stable fileId hash — "slab" (plain box, small files), "setback"
 *   (recessed upper tier, mid), "crown" (stepped massing + rooftop structure,
 *   tall). All variant geometries are normalized (footprint 1×1, base y=0,
 *   total height 1) so per-instance scale [w, h, d] keeps `h` EXACTLY the
 *   LOC-driven value — variation is horizontal/subtractive only.
 * - Windows: a procedural window grid injected into the shared standard
 *   material via onBeforeCompile (world-space cells, hash-lit warm windows).
 *   Zero geometry cost, zero texture assets, deterministic per world
 *   position. Roofs are subtly darkened in the same injection.
 * - Hover: store.hoveredId drives ONE shared overlay mesh repositioned in
 *   useFrame (zero React re-renders on the pointer hot path): a white-grey
 *   emissive shell + outline. Never hue.
 * - Selection: kept ×1.02 emissive overlay, now with a damped pulse and a
 *   ground spotlight ring. prefers-reduced-motion freezes the pulse.
 * - Fresh buildings (compare "added") rise from foundation height to full
 *   height once over RISE_DURATION on mount (ease-out, non-looping).
 * - LOD tiers (named constants below): past LOD_DETAIL_THRESHOLD the window
 *   shader and hover glow switch off (outline-only hover); past
 *   LOD_SHADOW_THRESHOLD buildings stop casting shadows.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Instance, Instances, Outlines } from "@react-three/drei";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Building } from "@/lib/city/layout";
import type { NodeChange, NodeStatus } from "@/lib/diff/apply";
import { useCityStore } from "@/lib/store";

/** Uniform building color — neutral zinc, identical for every file. */
const BUILDING_COLOR = "#8b8d98";
/** Emissive tint of the selection overlay (mirrored by the Legend swatch). */
const SELECTED_EMISSIVE = "#e4a33c";
/** Hover emissive — desaturated near-white, so hover never reads as hue. */
const HOVER_EMISSIVE = "#c9cede";
/** Overlay scale factor — just enough to clear the original faces. */
const SELECTION_SCALE = 1.02;

/** Compare-status colors — the ONLY places hue means anything (Legend pairs). */
export const STATUS_COLORS: Record<NodeStatus, string> = {
  construction: "#f59e0b", // amber — modified, construction site
  fresh: "#a3e635", // lime — added, fresh construction
  foundation: "#e2e8f0", // pale slate — untracked, freshly-poured foundation
  rubble: "#57534e", // warm grey — deleted, rubble (slab, not a building)
  moved: "#22d3ee", // cyan — renamed, moved marker
  blast: "#ef4444", // red — transitive importer of a changed file
};

/** Foundation slab height — fixed low: deliberately "not yet a building". */
const FOUNDATION_H = 0.9;

/** Past this building count: window shader off, hover glow → outline only. */
const LOD_DETAIL_THRESHOLD = 400;
/** Past this building count: buildings no longer cast shadows. */
const LOD_SHADOW_THRESHOLD = 900;

/** Fresh-building rise animation length (seconds), played once on mount. */
const RISE_DURATION = 1.5;

/** Selection pulse speed/amplitude — subtle breathing, not a strobe. */
const PULSE_SPEED = 2.4;
const PULSE_AMPLITUDE = 0.3;
const PULSE_BASE = 0.55;

/** Stable 32-bit hash — the only "randomness" source for shape picking. */
function hashCode(value: string): number {
  let hash = 7;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Shape vocabulary membership: height tier first (the skyline should read),
 * hash tie-breaks for variety. Deterministic per fileId — a building never
 * changes shape between renders of the same repo.
 */
type Variant = 0 | 1 | 2; // 0 slab · 1 setback · 2 crown
function variantFor(building: Building): Variant {
  const hash = hashCode(building.fileId);
  if (building.h < 5) return 0;
  if (building.h < 16) return hash % 3 === 0 ? 0 : 1;
  return hash % 4 === 0 ? 1 : 2;
}

/**
 * The three normalized variant geometries: footprint 1×1 centered, base at
 * y=0, total height exactly 1 — instance scale [w, h, d] maps them onto the
 * layout with height semantics untouched.
 */
function buildVariantGeometries(): [
  THREE.BufferGeometry,
  THREE.BufferGeometry,
  THREE.BufferGeometry,
] {
  const slab = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const setback = mergeGeometries([
    new THREE.BoxGeometry(1, 0.62, 1).translate(0, 0.31, 0),
    new THREE.BoxGeometry(0.68, 0.38, 0.68).translate(0, 0.62 + 0.19, 0),
  ]);
  const crown = mergeGeometries([
    new THREE.BoxGeometry(1, 0.55, 1).translate(0, 0.275, 0),
    new THREE.BoxGeometry(0.74, 0.3, 0.74).translate(0, 0.55 + 0.15, 0),
    new THREE.BoxGeometry(0.42, 0.15, 0.42).translate(0, 0.85 + 0.075, 0),
  ]);
  // mergeGeometries only fails on attribute mismatch (impossible for boxes) —
  // fall back to the slab so the render can never degenerate.
  return [slab, setback ?? slab, crown ?? slab];
}

/**
 * Procedural windows, injected into the shared material: a world-space grid
 * of bays (2.3u) × floors (2.7u) on near-vertical faces; each cell is hash-
 * lit with a warm emissive window. Deterministic per world position (no
 * clock, no Math.random), one compiled program shared by all variants.
 * Horizontal faces get a subtle roof darkening instead.
 */
function injectWindows(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
       varying vec3 vCityWorldPos;
       varying vec3 vCityWorldNormal;`,
    )
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
       vec4 cityWP = vec4(transformed, 1.0);
       vec3 cityN = objectNormal;
       #ifdef USE_INSTANCING
         cityWP = instanceMatrix * cityWP;
         cityN = mat3(instanceMatrix) * cityN;
       #endif
       vCityWorldPos = (modelMatrix * cityWP).xyz;
       vCityWorldNormal = normalize(mat3(modelMatrix) * cityN);`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
       varying vec3 vCityWorldPos;
       varying vec3 vCityWorldNormal;`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       {
         vec3 cityNrm = normalize(vCityWorldNormal);
         if (abs(cityNrm.y) < 0.55) {
           // Vertical faces: window grid in world space (never stretches).
           float cityU = abs(cityNrm.x) > abs(cityNrm.z) ? vCityWorldPos.z : vCityWorldPos.x;
           float cityV = vCityWorldPos.y;
           float fu = fract(cityU / 2.3);
           float fv = fract(cityV / 2.7);
           float win = step(0.22, fu) * step(fu, 0.78) * step(0.3, fv) * step(fv, 0.72);
           float cellId = floor(cityU / 2.3) * 131.0 + floor(cityV / 2.7) * 57.0;
           float rnd = fract(sin(cellId * 12.9898) * 43758.5453);
           float lit = step(0.6, rnd);
           float glow = win * lit * (0.25 + 0.75 * fract(rnd * 9.17));
           totalEmissiveRadiance += vec3(1.0, 0.85, 0.58) * glow * 0.5;
           diffuseColor.rgb *= 1.0 - win * 0.18;
         } else {
           // Roofs: subtle value drop so tops read as a separate plane.
           diffuseColor.rgb *= 0.8;
         }
       }`,
    );
}

/** Scratch objects for the fresh-rise matrix writes (module-level, reused). */
const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

/** One fresh building's rise-from-foundation animation target. */
interface RiseAnim {
  group: Variant;
  index: number;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export function Buildings({
  buildings,
  changes,
}: {
  buildings: Building[];
  changes?: Map<string, NodeChange>;
}) {
  const select = useCityStore((state) => state.select);
  const selectedId = useCityStore((state) => state.selectedId);
  const setHovered = useCityStore((state) => state.setHovered);
  const requestFocus = useCityStore((state) => state.requestFocus);

  const detailed = buildings.length <= LOD_DETAIL_THRESHOLD;
  const castShadow = buildings.length <= LOD_SHADOW_THRESHOLD;

  /** Rendered height: foundation status flattens; everything else keeps h. */
  const heightFor = (building: Building): number =>
    changes?.get(building.fileId)?.status === "foundation"
      ? Math.min(building.h, FOUNDATION_H)
      : building.h;

  const byId = useMemo(
    () => new Map(buildings.map((building) => [building.fileId, building])),
    [buildings],
  );

  const selected = useMemo(
    () => buildings.find((building) => building.fileId === selectedId) ?? null,
    [buildings, selectedId],
  );

  // Variant partition — index-in-group doubles as the instance index.
  const groups = useMemo<[Building[], Building[], Building[]]>(() => {
    const result: [Building[], Building[], Building[]] = [[], [], []];
    for (const building of buildings) {
      result[variantFor(building)].push(building);
    }
    return result;
  }, [buildings]);

  const geometries = useMemo(() => buildVariantGeometries(), []);
  useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries]);

  // Fresh-rise targets (compare "added" buildings only).
  const riseAnims = useMemo<RiseAnim[]>(() => {
    const anims: RiseAnim[] = [];
    groups.forEach((list, group) => {
      list.forEach((building, index) => {
        if (changes?.get(building.fileId)?.status === "fresh") {
          anims.push({
            group: group as Variant,
            index,
            x: building.x,
            z: building.z,
            w: building.w,
            d: building.d,
            h: building.h,
          });
        }
      });
    });
    return anims;
  }, [groups, changes]);

  const groupRefs = useRef<(THREE.InstancedMesh | null)[]>([null, null, null]);
  const riseStart = useRef<number | null>(null);
  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const hoverRef = useRef<THREE.Mesh>(null);
  const selectionMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    // --- Fresh-rise: override the fresh instances' matrices until done. ---
    if (riseAnims.length > 0 && !reducedMotion.current) {
      if (riseStart.current === null) riseStart.current = clock.elapsedTime;
      const t = clock.elapsedTime - riseStart.current;
      if (t <= RISE_DURATION + 0.05) {
        const k = Math.min(1, t / RISE_DURATION);
        const eased = 1 - Math.pow(1 - k, 3);
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
        }
      }
    }

    // --- Hover overlay: follow store.hoveredId without React re-renders. ---
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

    // --- Selection pulse (frozen for reduced-motion users). ---
    if (!reducedMotion.current) {
      const wave = Math.sin(clock.elapsedTime * PULSE_SPEED);
      if (selectionMaterialRef.current !== null) {
        selectionMaterialRef.current.emissiveIntensity = PULSE_BASE + PULSE_AMPLITUDE * wave;
      }
      if (ringRef.current !== null) {
        ringRef.current.scale.setScalar(1 + 0.05 * wave);
      }
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
              roughness={0.85}
              metalness={0}
              onBeforeCompile={detailed ? injectWindows : undefined}
            />
            {list.map((building) => {
              const status = changes?.get(building.fileId)?.status;
              const h = heightFor(building);
              return (
                <Instance
                  key={building.fileId}
                  color={status === undefined ? BUILDING_COLOR : STATUS_COLORS[status]}
                  position={[building.x, 0, building.z]}
                  scale={[building.w, h, building.d]}
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
              );
            })}
          </Instances>
        ),
      )}

      {/* Hover feedback — one shared mesh, repositioned per frame. */}
      <mesh ref={hoverRef} visible={false}>
        <boxGeometry />
        <meshStandardMaterial
          color={BUILDING_COLOR}
          emissive={HOVER_EMISSIVE}
          emissiveIntensity={0.5}
          transparent
          opacity={detailed ? 0.3 : 0}
          depthWrite={false}
          roughness={0.85}
          metalness={0}
        />
        <Outlines thickness={0.03} color="#dfe3ec" opacity={0.9} transparent />
      </mesh>

      {selected && (
        <group>
          {/* Selection glow — hue-free emissive over the neutral box. */}
          <mesh
            position={[
              selected.x,
              (heightFor(selected) * SELECTION_SCALE) / 2,
              selected.z,
            ]}
            scale={[
              selected.w * SELECTION_SCALE,
              heightFor(selected) * SELECTION_SCALE,
              selected.d * SELECTION_SCALE,
            ]}
          >
            <boxGeometry />
            <meshStandardMaterial
              ref={selectionMaterialRef}
              color={BUILDING_COLOR}
              emissive={SELECTED_EMISSIVE}
              emissiveIntensity={PULSE_BASE}
              roughness={0.85}
              metalness={0}
            />
          </mesh>
          {/* Ground spotlight ring under the selected building. */}
          <mesh
            ref={ringRef}
            position={[selected.x, 0.34, selected.z]}
            rotation-x={-Math.PI / 2}
          >
            <ringGeometry
              args={[
                Math.max(selected.w, selected.d) * 0.85,
                Math.max(selected.w, selected.d) * 1.2,
                48,
              ]}
            />
            <meshBasicMaterial
              color={SELECTED_EMISSIVE}
              transparent
              opacity={0.7}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}
