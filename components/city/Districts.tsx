"use client";

/**
 * Districts — folder blocks as warm diorama "city blocks": a cream CURB ring
 * frames a ground patch (lawn for leafy districts, plaza for high-traffic
 * ones), with a soft contact-shadow blob grounding the block onto the lawn.
 *
 * Ground-patch rule (deterministic, documented for the sim/render seam): a
 * district gets the PLAZA tone when its buildings' total LOC is at least
 * half of the busiest district's total LOC (high-traffic = downtown plaza);
 * every other district gets LAWN. Same layout in → same patch out.
 *
 * Nesting depth still reads via curb VALUE steps (deeper blocks get slightly
 * deeper curb tones) — no hue encoding anywhere.
 *
 * Labels (opt-in via store.showLabels): Small World white pills — white
 * surface, dark ink text, rounded-full, soft pill shadow — floating above
 * the block's tallest building. Faded and scaled by camera distance in
 * useFrame; pointerEvents stay off.
 *
 * District hover: when the pointer hovers a BUILDING, its containing
 * district's curb brightens (subtle warm lift). The lookup runs on a
 * prebuilt Map<fileId, districtPath> and mutates materials in useFrame via
 * store.getState() — no React re-renders on the hover hot path.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";

import type { Building, District } from "@/lib/city/layout";
import { GROUND_COLORS } from "@/lib/city/theme";
import { useCityStore } from "@/lib/store";

/** Curb value range: depth 0 starts at BASE, deepening toward TOP. */
const CURB_BASE = "#E6E1D8";
const CURB_TOP = "#CFC7B8";
const CURB_HOVER_EMISSIVE = "#fff3d6";
/** Ground patch tops (thin raised patch above the lawn plane at y=0). */
const PATCH_Y = 0.05;
const PATCH_H = 0.1;
/** Curb height: raised edge between street and block (top at 0.18). */
const CURB_H = 0.18;
/** Contact shadow softness: lighter than the old dark theme. */
const SHADOW_ALPHA = 0.32;
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
  gradient.addColorStop(0, `rgba(0,0,0,${SHADOW_ALPHA})`);
  gradient.addColorStop(0.7, `rgba(0,0,0,${(SHADOW_ALPHA * 0.4).toFixed(2)})`);
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

/** Plaza rule: total building height (LOC proxy) ≥ half the busiest district's. */
function isPlazaDistrict(district: District, totalHeight: Map<string, number>): boolean {
  const own = totalHeight.get(district.path) ?? 0;
  let max = 0;
  for (const value of totalHeight.values()) max = Math.max(max, value);
  return own >= max / 2 && own > 0;
}

/**
 * Small World district label: a white pill — surface background, dark ink
 * text, rounded-full, soft pill shadow — pinned to the CENTER of its
 * cluster, floating just above the block's tallest building. Fades and
 * scales by camera distance.
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
        className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          boxShadow: "var(--pill-shadow)",
        }}
      >
        <span
          className="whitespace-nowrap text-[11px] font-semibold leading-none"
          style={{ color: "var(--ink)" }}
        >
          {district.label}
        </span>
        <span
          className="whitespace-nowrap text-[10px] leading-none"
          style={{ color: "var(--ink-secondary)" }}
        >
          {count} {count === 1 ? "file" : "files"}
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

  // Recursive file count / tallest building per district + exact containing
  // district per file (longest path prefix wins) — pure layout derivations.
  const { counts, maxHeights, buildingToDistrict, totalHeight } = useMemo(() => {
    const counts = new Map<string, number>();
    const maxHeights = new Map<string, number>();
    const buildingToDistrict = new Map<string, string>();
    const totalHeight = new Map<string, number>();
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
          totalHeight.set(path, (totalHeight.get(path) ?? 0) + building.h);
        }
      }
    }
    return { counts, maxHeights, buildingToDistrict, totalHeight };
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
      const target = path === hoveredDistrict ? 0.35 : 0;
      material.emissiveIntensity = THREE.MathUtils.damp(material.emissiveIntensity, target, 8, delta);
    });
  });

  return (
    <group>
      {districts.map((district) => {
        const curbWidth = Math.min(
          0.6 + district.depth * 0.1,
          district.w / 4,
          district.d / 4,
        );
        const curbColor = curbColorFor(district.depth);
        const patchColor = isPlazaDistrict(district, totalHeight)
          ? GROUND_COLORS.plaza
          : GROUND_COLORS.lawn;
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
            {/* Curb: the raised cream frame between street and block. */}
            <mesh
              position={[0, CURB_H / 2, 0]}
              receiveShadow
              ref={(mesh: THREE.Mesh | null) => {
                if (mesh === null) curbRefs.current.delete(district.path);
                else curbRefs.current.set(district.path, mesh);
              }}
            >
              <boxGeometry args={[district.w, CURB_H, district.d]} />
              <meshStandardMaterial
                color={curbColor}
                emissive={CURB_HOVER_EMISSIVE}
                emissiveIntensity={0}
                roughness={0.9}
                metalness={0}
              />
            </mesh>
            {/* Ground patch: lawn or plaza tone, slightly above the lawn. */}
            <mesh position={[0, PATCH_Y, 0]} receiveShadow>
              <boxGeometry
                args={[district.w - 2 * curbWidth, PATCH_H, district.d - 2 * curbWidth]}
              />
              <meshStandardMaterial color={patchColor} roughness={0.95} metalness={0} />
            </mesh>
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
