"use client";

/**
 * The diorama's ground surface — a warm lawn plane sized to the city rect
 * plus a margin, sitting at y=0 on top of the wooden slab stack
 * ({@link DioramaBase} renders the strata below).
 *
 * The canvas texture is deliberately near-white with faint speckle: the map
 * only contributes variation, the hue comes from `GROUND_COLORS.lawn` via the
 * material color (map × color multiply), so the lawn stays light and warm in
 * every phase. Wet weather darkens toward `lawnDeep` and adds a slight sheen.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { GROUND_COLORS } from "@/lib/city/theme";

import type { LayoutBounds } from "./orbitMath";
import { useSceneEnv } from "./sceneEnv";

/** Lawn extends this far past the city rect on every side. */
const LAWN_MARGIN = 24;
/** One texture tile covers this many world units. */
const TILE_SIZE = 48;

/**
 * Runtime-generated lawn speckle — seeded PRNG (LCG) keeps it deterministic,
 * same contract as the rest of the scene: procedural detail must be stable
 * in shape for a given city.
 */
function makeLawnTexture(): THREE.CanvasTexture | null {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;

  // Near-white base — the material color supplies the actual lawn hue.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  let seed = 4242;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  // Grass speckle — faint warm-dark and light flecks at sub-pixel scale.
  for (let i = 0; i < 2400; i++) {
    const alpha = 0.015 + rand() * 0.045;
    ctx.fillStyle = rand() > 0.5 ? `rgba(74,84,58,${alpha})` : `rgba(255,255,255,${alpha})`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
  }
  // Soft mottled patches — large, very low alpha, uneven lawn tone.
  for (let i = 0; i < 14; i++) {
    const alpha = 0.02 + rand() * 0.03;
    ctx.fillStyle = `rgba(96,104,72,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(
      rand() * size,
      rand() * size,
      30 + rand() * 70,
      30 + rand() * 70,
      rand() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

export function Environment({ bounds }: { bounds: LayoutBounds }) {
  const env = useSceneEnv();
  const texture = useMemo(() => makeLawnTexture(), []);
  useEffect(() => () => texture?.dispose(), [texture]);

  const width = bounds.maxX - bounds.minX + LAWN_MARGIN * 2;
  const depth = bounds.maxZ - bounds.minZ + LAWN_MARGIN * 2;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  useEffect(() => {
    if (texture !== null) texture.repeat.set(width / TILE_SIZE, depth / TILE_SIZE);
  }, [texture, width, depth]);

  // Wet ground darkens toward lawnDeep and gains a rain sheen.
  const color = useMemo(() => {
    const c = new THREE.Color(GROUND_COLORS.lawn);
    if (env.wet > 0) c.lerp(new THREE.Color(GROUND_COLORS.lawnDeep), env.wet * 0.6);
    return c;
  }, [env.wet]);

  return (
    <mesh rotation-x={-Math.PI / 2} position={[centerX, 0, centerZ]} receiveShadow>
      <planeGeometry args={[width, depth]} />
      <meshStandardMaterial
        color={color}
        map={texture ?? undefined}
        roughness={0.95 - env.wet * 0.35}
        metalness={env.wet * 0.08}
      />
    </mesh>
  );
}
