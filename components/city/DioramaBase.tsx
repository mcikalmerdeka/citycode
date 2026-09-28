"use client";

/**
 * The wooden board under the city — the Small World plywood block: a thick,
 * flush-sided slab built from thin alternating wood laminations, plus a soft
 * drop shadow on the stage so the board floats like a tabletop model.
 *
 * The board footprint matches the ground plane exactly (Environment's lawn
 * margin), so the concrete runs right to the edge and the wood only shows on
 * the sides — the reference look.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { LayoutBounds } from "./orbitMath";

/** Must match Environment.tsx LAWN_MARGIN so board and ground are flush. */
const GROUND_MARGIN = 24;
/** Lamination stack, top first: light birch alternating with deeper ply. */
const LAYERS = [
  { tone: "#D8C29C", thickness: 1.6 },
  { tone: "#C4A87C", thickness: 0.45 },
  { tone: "#DCC6A1", thickness: 1.8 },
  { tone: "#C1A378", thickness: 0.45 },
  { tone: "#D6BF97", thickness: 1.8 },
  { tone: "#BF9F72", thickness: 0.45 },
  { tone: "#D3BA91", thickness: 1.8 },
  { tone: "#B8976A", thickness: 0.6 },
] as const;
const TOTAL_THICKNESS = LAYERS.reduce((sum, layer) => sum + layer.thickness, 0);

/** Soft rectangular drop-shadow texture (blurred rounded rect). */
function makeShadowTexture(): THREE.CanvasTexture | null {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.filter = "blur(18px)";
  ctx.fillStyle = "rgba(60,48,30,0.38)";
  ctx.fillRect(size * 0.16, size * 0.16, size * 0.68, size * 0.68);
  return new THREE.CanvasTexture(canvas);
}

export function DioramaBase({ bounds }: { bounds: LayoutBounds }) {
  const width = bounds.maxX - bounds.minX + GROUND_MARGIN * 2;
  const depth = bounds.maxZ - bounds.minZ + GROUND_MARGIN * 2;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  const materials = useMemo(
    () =>
      LAYERS.map(
        (layer) => new THREE.MeshStandardMaterial({ color: layer.tone, roughness: 0.85, metalness: 0 }),
      ),
    [],
  );
  const shadowTexture = useMemo(() => makeShadowTexture(), []);
  useEffect(
    () => () => {
      materials.forEach((material) => material.dispose());
      shadowTexture?.dispose();
    },
    [materials, shadowTexture],
  );

  // Stack downward from just under the ground plane (y=0).
  const layers = LAYERS.map((layer, i) => ({
    ...layer,
    y: -0.02 - LAYERS.slice(0, i).reduce((sum, l) => sum + l.thickness, 0) - layer.thickness / 2,
  }));

  return (
    <group>
      {layers.map((layer, i) => (
        <mesh
          key={`ply-${i}`}
          position={[centerX, layer.y, centerZ]}
          material={materials[i]}
          castShadow={i === 0}
          receiveShadow
        >
          <boxGeometry args={[width, layer.thickness, depth]} />
        </mesh>
      ))}
      {shadowTexture !== null && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[centerX + 10, -TOTAL_THICKNESS - 0.3, centerZ + 16]}
          scale={[width * 1.45, depth * 1.45, 1]}
        >
          <planeGeometry />
          <meshBasicMaterial map={shadowTexture} transparent depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
