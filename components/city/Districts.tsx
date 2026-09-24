"use client";

/**
 * Districts — folder blocks upgraded from flat slabs to "pavement plateaus":
 * a brighter raised CURB ring frames a recessed inner slab, with a soft
 * contact-shadow blob grounding the block onto the asphalt plane. Deep
 * nesting reads via depth-styled curbs (brighter/thicker with `depth`) and
 * small corner chips on depth ≥ 2 blocks.
 *
 * All depths still share one color FAMILY: nesting is expressed by geometry
 * and value steps, never hue — the reserved-color contract is untouched.
 *
 * Labels (opt-in via store.showLabels): district name + recursive file
 * count, faded and scaled by camera distance in useFrame. True raycast
 * occlusion was rejected on cost (one ray per label per frame against the
 * whole city vs. the frame budget); distance fade gives the same "don't
 * clutter the skyline" result at zero raycast cost. pointerEvents stay off.
 *
 * District hover: when the pointer hovers a BUILDING, its containing
 * district's curb gently brightens (visual grouping). The lookup runs on a
 * prebuilt Map<fileId, districtPath> and mutates materials in useFrame via
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

/** Distance-faded district label: name + recursive file count. */
function DistrictLabel({ district, count }: { district: District; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const camera = useThree((state) => state.camera);

  useFrame(() => {
    const element = ref.current;
    if (element === null) return;
    const distance = camera.position.distanceTo(
      tmpVector.set(district.x, 1.2, district.z),
    );
    const opacity = THREE.MathUtils.clamp(
      (LABEL_FADE_FAR - distance) / (LABEL_FADE_FAR - LABEL_FADE_NEAR),
      0,
      1,
    );
    const scale = THREE.MathUtils.clamp(1.15 - distance / 500, 0.7, 1.05);
    element.style.opacity = opacity.toFixed(3);
    element.style.transform = `scale(${scale.toFixed(3)})`;
  });

  return (
    <Html position={[0, 1.2, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
      <div
        ref={ref}
        className="flex items-center gap-1.5 whitespace-nowrap rounded border border-zinc-700/60 bg-zinc-950/70 px-1.5 py-0.5 backdrop-blur-[2px]"
      >
        {/* CSS folder badge: body + tab, no icon font needed */}
        <span aria-hidden="true" className="relative block h-2 w-3 rounded-[1.5px] bg-zinc-500">
          <span className="absolute -top-[3px] left-0 h-[3px] w-[6px] rounded-t-[1.5px] bg-zinc-500" />
        </span>
        <span className="font-mono text-[10px] leading-none text-zinc-300">
          {district.label}
        </span>
        <span className="font-mono text-[9px] leading-none text-zinc-500">
          · {count} {count === 1 ? "file" : "files"}
        </span>
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

  // Recursive file count per district + exact containing district per file
  // (longest path prefix wins) — both pure derivations from the layout.
  const { counts, buildingToDistrict } = useMemo(() => {
    const counts = new Map<string, number>();
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
        }
      }
    }
    return { counts, buildingToDistrict };
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

  // Curb hover-brighten: damped emissive toward the hovered building's block.
  const curbRefs = useRef(new Map<string, THREE.Mesh>());
  useFrame((_, delta) => {
    const hoveredId = useCityStore.getState().hoveredId;
    const hoveredDistrict = hoveredId === null ? undefined : buildingToDistrict.get(hoveredId);
    curbRefs.current.forEach((mesh, path) => {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const target = path === hoveredDistrict ? 0.45 : 0;
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
              <DistrictLabel district={district} count={counts.get(district.path) ?? 0} />
            )}
          </group>
        );
      })}
    </group>
  );
}
