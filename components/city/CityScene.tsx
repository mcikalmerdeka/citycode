"use client";

/**
 * The static 3D city view — an R3F Canvas rendering a {@link CityLayout}
 * verbatim (no client-side re-derivation of geometry).
 *
 * Visual contract (Phase 2): neutral zinc palette only. Building hue is
 * uniform because color is reserved for the Phase 4/5 compare modes; the
 * single exception is the selection highlight (see Buildings.tsx).
 */

import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

import type { CityLayout } from "@/lib/city/layout";
import type { ChangeSet } from "@/lib/diff/apply";
import { useCityStore } from "@/lib/store";

import { Buildings } from "./Buildings";
import { ChangeOverlays } from "./ChangeOverlays";
import { Districts } from "./Districts";
import { Roads } from "./Roads";
import { installThreeConsoleFilter } from "./threeConsoleFilter";

// Drop the R3F-internal THREE.Clock deprecation warning (removal condition
// documented in threeConsoleFilter.ts — gone once fiber v10 stable ships).
installThreeConsoleFilter();

/** Scene background — near-black zinc, slightly warmer than the ground. */
const SCENE_BACKGROUND = "#0b0c0f";
/** Ground plane color — one step lighter so the horizon reads. */
const GROUND_COLOR = "#131418";

export function CityScene({
  layout,
  changeSet,
}: {
  layout: CityLayout;
  /** Present only in compare modes (Phase 4) — drives hues but never geometry. */
  changeSet?: ChangeSet | null;
}) {
  const select = useCityStore((state) => state.select);
  const compareMap = changeSet === undefined || changeSet === null ? undefined : new Map(changeSet.changes.map((change) => [change.fileId, change]));

  return (
    <Canvas
      camera={{ position: [120, 140, 160], fov: 50 }}
      onPointerMissed={() => select(null)}
    >
      <color attach="background" args={[SCENE_BACKGROUND]} />

      {/* Flat, shadowless lighting — depth comes from geometry, not shadows. */}
      <ambientLight intensity={0.7} />
      <directionalLight position={[90, 130, 70]} intensity={1.1} />

      {/* Large ground plane so the city never floats on a visible edge. */}
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[2000, 2000]} />
        <meshStandardMaterial color={GROUND_COLOR} roughness={1} metalness={0} />
      </mesh>

      {/*
       * Keyed by repoPath + building count: analyzing a different folder (or
       * the same folder after files were added/removed) remounts the whole
       * city instead of patching instanced matrices in place.
       */}
      <group key={`${layout.repoPath}:${layout.buildings.length}`}>
        <Districts districts={layout.districts} />
        <Roads roads={layout.roads} />
        <Buildings buildings={layout.buildings} changes={compareMap} />
        {changeSet !== undefined && changeSet !== null && (
          <ChangeOverlays layout={layout} changeSet={changeSet} />
        )}
      </group>

      <OrbitControls target={[0, 0, 0]} enableDamping dampingFactor={0.08} />
    </Canvas>
  );
}
