"use client";

/**
 * Districts — folder blocks upgraded from flat slabs to "pavement plateaus":
 * a brighter raised CURB ring frames a recessed inner slab, with a soft
 * contact-shadow blob grounding the block onto the asphalt plane. Deep
 * nesting reads via depth-styled curbs (brighter/thicker with `depth`) and
 * small corner chips on depth ≥ 2 blocks.
 *
 * ALL depths still share one color FAMILY: nesting is expressed by geometry
 * and value steps, never hue — the reserved-color contract is untouched.
 *
 * Border light: a thin luminous rim strip rides the top edge of every curb
 * (video-game style cluster border) so each district reads as a clearly
 * separated area, even mid-scene against window textures. Grey/steel tones
 * only — still out of the reserved hue channel. District hover ALSO lifts
 * this rim together with the curb (brightened + glow), which doubles as the
 * visual grouping cue.
 *
 * Labels (opt-in via store.showLabels): game-plaquette style — dark panel
 * with a light border + soft glow, district name in caps at the TOP of the
 * plaque, recursive file count below. Pinned to the dead CENTER of each
 * cluster, hovering just above the block's tallest building so every
 * cluster's label is readable and unambiguous about which buildings belong
 * to it. Faded and scaled by camera distance in useFrame. True raycast
 * occlusion was rejected on cost (one ray per label per frame against the
 * whole city vs. the frame budget); the max-height anchor gives an
 * occlusion-resistant vantage instead. pointerEvents stay off.
 *
 * District hover: when the pointer hovers a BUILDING, its containing
 * district's curb brightens. The lookup runs on a prebuilt
 * Map<fileId, districtPath> and mutates materials in useFrame via
 * store.getState() — no React re-renders on the hover hot path.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";

import type { Building, District } from "@/lib/city/layout";
import { useCityStore } from "@/lib/store";

const DISTRICT_COLOR = "#2a2c33";
/** Curb value range: depth 0 starts at BASE, lightening toward TOP. */
const CURB_BASE = "#3a3d47";
const CURB_TOP = "#565a68";
const CURB_HOVER_EMISSIVE = "#aeb6cc";
/** Border-light rim (grey/steel — luminous, not hue). */
const RIM_COLOR = "#c3c9d6";
const RIM_HOVER_EMISSIVE = "#ffffff";
/** Rim strip profile: tall enough to read as a glowing kerb tube at range. */
const RIM_H = 0.3;
const RIM_T = 0.2;
const RIM_TOP = 0.24 + RIM_H / 2;
/** Resting emissive of a rim (hover lifts it to 0.9). */
const RIM_BASE = 0.35;
/**
 * Defensive fallback for a district missing its material entry (unreachable:
 * rimMaterials covers every district) — keeps the render total.
 */
const rimFallback = new THREE.MeshStandardMaterial({
  color: RIM_COLOR,
  emissive: RIM_HOVER_EMISSIVE,
  emissiveIntensity: RIM_BASE,
  roughness: 0.35,
});
/** Corner chip size/height for depth ≥ 2 blocks (world units). */
const CHIP = 0.5;
const CHIP_H = 0.18;
/** Label fade: fully visible below ~75u, gone past ~300u. */
const LABEL_FADE_NEAR = 75;
const LABEL_FADE_FAR = 300;

/** Scratch vector for per-label camera distance checks. */
const tmpVector = new THREE.Vector3();

/** Soft radial blob used as a cheap contact shadow under each block. */
function makeContactShadowTexture(): THREE.CanvasTexture | null {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(0.7, "rgba(0,0,0,0.22)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Depth-styled curb color: deterministic value step per nesting level. */
function curbColorFor(depth: number): string {
  const color = new THREE.Color(CURB_BASE);
  color.lerp(new THREE.Color(CURB_TOP), Math.min(depth * 0.18, 0.65));
  return `#${color.getHexString()}`;
}

/**
 * Game-plaquette district label: dark panel + light border + soft glow,
 * district name in caps at the TOP, recursive file count below, pinned to
 * the CENTER of its cluster — floating just above the block's tallest
 * building, so no cluster's label can be buried or occluded mid-block.
 * Fades and scales by camera distance.
 */
function DistrictLabel({
  district,
  count,
  anchorY,
}: {
  district: District;
  count: number;
  /** World height the label hovers at: the block's tallest building + gap. */
  anchorY: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const camera = useThree((state) => state.camera);

  useFrame(() => {
    const element = ref.current;
    if (element === null) return;
    const distance = camera.position.distanceTo(
      tmpVector.set(district.x, anchorY, district.z),
    );
    const opacity = THREE.MathUtils.clamp(
      (LABEL_FADE_FAR - distance) / (LABEL_FADE_FAR - LABEL_FADE_NEAR),
      0,
      1,
    );
    const scale = THREE.MathUtils.clamp(1.2 - distance / 560, 0.72, 1.1);
    element.style.opacity = opacity.toFixed(3);
    element.style.transform = `scale(${scale.toFixed(3)})`;
  });

  return (
    <Html position={[0, anchorY, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
      <div
        ref={ref}
        className="relative flex flex-col items-center"
        style={{ filter: "drop-shadow(0 0 6px rgba(195,201,214,0.45))" }}
      >
        {/* Plaque: name on top (caps), count under it */}
        <div className="flex flex-col items-center gap-1 rounded-md border border-zinc-400/50 bg-zinc-950/80 px-3 py-1.5 shadow-[0_0_18px_rgba(190,200,220,0.22),inset_0_0_10px_rgba(190,200,220,0.07)] backdrop-blur-[2px]">
          <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] font-medium uppercase leading-none tracking-[0.16em] text-zinc-100">
            {/* CSS folder badge: body + tab, no icon font needed */}
            <span aria-hidden="true" className="relative block h-2.5 w-3.5 rounded-[1.5px] bg-zinc-300">
              <span className="absolute -top-[3px] left-0 h-[3px] w-[7px] rounded-t-[1.5px] bg-zinc-300" />
            </span>
            {district.label}
          </span>
          <span className="whitespace-nowrap font-mono text-[9px] uppercase leading-none tracking-[0.14em] text-zinc-400">
            {count} {count === 1 ? "file" : "files"}
          </span>
        </div>
        {/* Stem + glowing anchor dot pinning the banner into the cluster */}
        <div aria-hidden="true" className="flex flex-col items-center">
          <span className="block h-3 w-px bg-zinc-400/55" />
          <span className="block h-1 w-1 rounded-full bg-zinc-300 shadow-[0_0_4px_rgba(195,201,214,0.9)]" />
        </div>
      </div>
    </Html>
  );
}

export function Districts({
  districts,
  buildings,
}: {
  districts: District[];
  buildings: Building[];
}) {
  const showLabels = useCityStore((state) => state.showLabels);

  // Recursive file count / tallest building per district + exact containing
  // district per file (longest path prefix wins) — pure layout derivations.
  const { counts, maxHeights, buildingToDistrict } = useMemo(() => {
    const counts = new Map<string, number>();
    const maxHeights = new Map<string, number>();
    const buildingToDistrict = new Map<string, string>();
    const sortedPaths = districts.map((district) => district.path).sort((a, b) => a.length - b.length);
    for (const building of buildings) {
      let owner: string | null = null;
      for (const path of sortedPaths) {
        if (building.fileId.startsWith(`${path}/`)) {
          owner = path; // ascending length → last match is the longest prefix
        }
      }
      if (owner !== null) {
        buildingToDistrict.set(building.fileId, owner);
      }
      for (const path of sortedPaths) {
        if (building.fileId.startsWith(`${path}/`)) {
          counts.set(path, (counts.get(path) ?? 0) + 1);
          maxHeights.set(path, Math.max(maxHeights.get(path) ?? 0, building.h));
        }
      }
    }
    return { counts, maxHeights, buildingToDistrict };
  }, [districts, buildings]);

  // Shared contact-shadow plane (one geometry + one material for all blocks).
  const contact = useMemo(() => {
    const texture = makeContactShadowTexture();
    if (texture === null) return null;
    return {
      geometry: new THREE.PlaneGeometry(1, 1),
      material: new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    };
  }, []);
  useEffect(
    () => () => {
      contact?.geometry.dispose();
      contact?.material.map?.dispose();
      contact?.material.dispose();
    },
    [contact],
  );

  // One emissive material per district for its four border-light strips;
  // created before the useFrame that mutates them each frame.
  const rimMaterials = useMemo(() => {
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    for (const district of districts) {
      materials.set(
        district.path,
        new THREE.MeshStandardMaterial({
          color: RIM_COLOR,
          emissive: RIM_HOVER_EMISSIVE,
          emissiveIntensity: RIM_BASE,
          roughness: 0.35,
          metalness: 0,
        }),
      );
    }
    return materials;
  }, [districts]);
  useEffect(
    () => () => {
      rimMaterials.forEach((material) => material.dispose());
    },
    [rimMaterials],
  );

  // Curb hover-brighten: damped emissive toward the hovered building's block.
  // Rim strips share ONE material per district (rimMaterials) — mutating the
  // material's emissive covers all four sides at once.
  const curbRefs = useRef(new Map<string, THREE.Mesh>());
  useFrame((_, delta) => {
    const hoveredId = useCityStore.getState().hoveredId;
    const hoveredDistrict = hoveredId === null ? undefined : buildingToDistrict.get(hoveredId);
    curbRefs.current.forEach((mesh, path) => {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const target = path === hoveredDistrict ? 0.45 : 0;
      material.emissiveIntensity = THREE.MathUtils.damp(material.emissiveIntensity, target, 8, delta);
    });
    rimMaterials.forEach((material, path) => {
      const target = path === hoveredDistrict ? 0.9 : RIM_BASE;
      material.emissiveIntensity = THREE.MathUtils.damp(material.emissiveIntensity, target, 8, delta);
    });
  });

  return (
    <group>
      {districts.map((district) => {
        const curbWidth = Math.min(
          0.35 + district.depth * 0.15,
          district.w / 4,
          district.d / 4,
        );
        const curbColor = curbColorFor(district.depth);
        return (
          <group key={district.path} position={[district.x, 0, district.z]}>
            {contact !== null && (
              <mesh
                position={[0, 0.015, 0]}
                rotation-x={-Math.PI / 2}
                scale={[district.w * 1.25, district.d * 1.25, 1]}
                geometry={contact.geometry}
                material={contact.material}
                dispose={null}
              />
            )}
            {/* Curb: the raised, brighter frame (top y = 0.24). */}
            <mesh
              position={[0, 0.12, 0]}
              receiveShadow
              ref={(mesh: THREE.Mesh | null) => {
                if (mesh === null) curbRefs.current.delete(district.path);
                else curbRefs.current.set(district.path, mesh);
              }}
            >
              <boxGeometry args={[district.w, 0.24, district.d]} />
              <meshStandardMaterial
                color={curbColor}
                emissive={CURB_HOVER_EMISSIVE}
                emissiveIntensity={0}
                roughness={0.9}
                metalness={0}
              />
            </mesh>
            {/* Inner slab: recessed pavement (top y = 0.2, as before). */}
            <mesh position={[0, 0.1, 0]} receiveShadow>
              <boxGeometry
                args={[district.w - 2 * curbWidth, 0.2, district.d - 2 * curbWidth]}
              />
              <meshStandardMaterial color={DISTRICT_COLOR} roughness={1} metalness={0} />
            </mesh>
            {/*
             * Border light: a luminous rim riding the curb's top edge — four
             * thin emissive strips (shared per-district material) so the
             * cluster boundary reads from any angle. Grey/steel luminance
             * only (hue stays reserved).
             */}
            {([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).map(([sx, sz]) => {
              const alongX = sz === 0; // strip runs along X when offset in Z
              const length = alongX ? district.w : district.d;
              const cross = alongX ? district.d : district.w;
              return (
                <mesh
                  key={`rim:${sx}:${sz}`}
                  position={[
                    sx * (alongX ? 0 : cross / 2),
                    RIM_TOP,
                    sz * (alongX ? cross / 2 : 0),
                  ]}
                  material={rimMaterials.get(district.path) ?? rimFallback}
                  dispose={null}
                >
                  <boxGeometry
                    args={alongX ? [length, RIM_H, RIM_T] : [RIM_T, RIM_H, length]}
                  />
                </mesh>
              );
            })}
            {/* Corner chips mark deeply nested blocks. */}
            {district.depth >= 2 &&
              ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([sx, sz]) => (
                <mesh
                  key={`${sx}:${sz}`}
                  position={[
                    sx * (district.w / 2 - CHIP / 2),
                    0.24 + CHIP_H / 2,
                    sz * (district.d / 2 - CHIP / 2),
                  ]}
                >
                  <boxGeometry args={[CHIP, CHIP_H, CHIP]} />
                  <meshStandardMaterial color={CURB_TOP} roughness={0.85} metalness={0} />
                </mesh>
              ))}
            {showLabels && (
              <DistrictLabel
                district={district}
                count={counts.get(district.path) ?? 0}
                anchorY={(maxHeights.get(district.path) ?? 3) + 2.2}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}
