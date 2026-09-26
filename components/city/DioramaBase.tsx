"use client";

/**
 * The stacked wooden slab under the city — the plywood-strata base from the
 * Small World reference: 3–4 thin boxes with slightly varied warm wood tones,
 * each wider than the one above, extending downward from y=0.
 *
 * The top slab's top face is the "table" the lawn sits on; the visible edges
 * between slabs read as plywood layers. Simple boxes, no normal maps — the
 * look comes from the tone steps and the soft key-light shadowing.
 */

import { useMemo } from "react";
import * as THREE from "three";

import type { LayoutBounds } from "./orbitMath";

/** Slab stack definition: one entry per plywood layer, top first. */
const SLABS = [
  { tone: "#C9B391", thickness: 2.2, overhang: 26 },
  { tone: "#BDAA84", thickness: 2.6, overhang: 32 },
  { tone: "#B1976F", thickness: 3.0, overhang: 38 },
  { tone: "#A3865F", thickness: 3.4, overhang: 44 },
] as const;

/** Extra padding beyond the layout rect so the slab edge is always visible. */
const BASE_MARGIN = 6;

export function DioramaBase({ bounds }: { bounds: LayoutBounds }) {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  const materials = useMemo(
    () =>
      SLABS.map(
        (slab) =>
          new THREE.MeshStandardMaterial({
            color: slab.tone,
            roughness: 0.92,
            metalness: 0,
          }),
      ),
    [],
  );

  // y positions: stack downward from just under the ground plane (y=0).
  // Pure prefix sum (no outer-let mutation) — each slab sits below the
  // cumulative thickness of the slabs above it, with a tiny overlap into the
  // lawn plane to avoid a hairline gap.
  const slabs = SLABS.map((slab, i) => ({
    ...slab,
    y:
      -0.05 -
      SLABS.slice(0, i).reduce((sum, s) => sum + s.thickness, 0) -
      slab.thickness / 2,
    key: `slab-${i}`,
  }));

  return (
    <group>
      {slabs.map((slab, i) => (
        <mesh
          key={slab.key}
          position={[centerX, slab.y, centerZ]}
          material={materials[i]}
          castShadow
          receiveShadow
        >
          <boxGeometry
            args={[
              width + (slab.overhang + BASE_MARGIN) * 2,
              slab.thickness,
              depth + (slab.overhang + BASE_MARGIN) * 2,
            ]}
          />
        </mesh>
      ))}
    </group>
  );
}
