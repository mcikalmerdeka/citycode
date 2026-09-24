"use client";

/**
 * The static 3D city view — an R3F Canvas rendering a {@link CityLayout}
 * verbatim (no client-side re-derivation of geometry).
 *
 * Visual contract (Phase 2): neutral zinc palette only. Building hue is
 * uniform because color is reserved for the Phase 4/5 compare modes; the
 * single exception is the selection highlight (see Buildings.tsx).
 *
 * Phase 3D scene & atmosphere overhaul:
 * - Lighting rig: warm key directional with shadows (frustum tuned to the
 *   200×200 root rect, 2048 map — 1024 past SHADOW_MAP_LOD_THRESHOLD
 *   buildings), a cool hemisphere fill, and a cold rim light from the
 *   opposite side. The old flat ambient+directional pair is gone. Shadow
 *   type is PCF: three r182+ removed PCFSoftShadowMap and made PCFShadowMap
 *   soft by default (Vogel-disk sampling), so "soft" shadow types trip a
 *   deprecation warning in WebGLShadowMap for no quality gain.
 * - Atmosphere: exponential fog blends the city edge into a hand-tuned
 *   gradient sky dome (deep-blue dusk, subtle warm band at the horizon) —
 *   fully procedural, no HDRI/network assets.
 * - Ground: one large plane with a runtime-generated canvas texture (seeded
 *   asphalt speckle + city grid) so the world never reads as a flat void.
 * - CameraRig: OrbitControls plus a store-driven fly-to (see focusRequest in
 *   lib/store.ts). User input mid-tween cancels the flight; a fresh city
 *   remount resets to the default overview.
 * - Postprocessing via @react-three/postprocessing (the single dependency
 *   this phase adds): very low bloom so only emissive glows (selection,
 *   crane beacons, blast pulses) bloom, a screen vignette, and SMAA — the
 *   Canvas' own MSAA is off because SMAA replaces it.
 */

import { useEffect, useMemo, useRef } from "react";
import type { ComponentRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, SMAA } from "@react-three/postprocessing";

import type { Building, CityLayout } from "@/lib/city/layout";
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

/** Fog/background — deep-blue dusk haze the city dissolves into. */
const DUSK_FOG = "#101b30";
/** Sky dome gradient stops (horizon reads slightly lighter than the fog). */
const SKY_HORIZON = "#1a2a48";
const SKY_ZENITH = "#04060c";
/** Exponential fog density: ~17% haze at 200 units, ~70% at 500. */
const FOG_DENSITY = 0.0022;

/** Default overview — a fresh city always opens from this vantage. */
const OVERVIEW_POSITION: [number, number, number] = [140, 155, 180];

/** Key-light shadow frustum half-extent: root rect is 200×200 → ±100 + margin. */
const SHADOW_EXTENT = 125;
/** Above this building count the shadow map drops 2048 → 1024. */
const SHADOW_MAP_LOD_THRESHOLD = 800;

/** Camera limits — close enough to read windows, far enough for the skyline. */
const MIN_DISTANCE = 18;
const MAX_DISTANCE = 520;
const MIN_POLAR = 0.1;
const MAX_POLAR = 1.44; // ≈82.5° — never dips under the ground plane

/** Fly-to tween duration (seconds) and easing power. */
const FLY_DURATION = 0.8;

/**
 * Runtime-generated asphalt/grid texture for the ground plane. Seeded PRNG
 * (LCG) keeps the speckle deterministic — procedural detail must be stable
 * in shape for a given city, only clock-based motion may vary.
 */
function makeGroundTexture(): THREE.CanvasTexture | null {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;

  ctx.fillStyle = "#14161c";
  ctx.fillRect(0, 0, size, size);

  let seed = 1337;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  // Asphalt speckle — value noise at sub-pixel scale.
  for (let i = 0; i < 2600; i++) {
    const alpha = 0.015 + rand() * 0.04;
    ctx.fillStyle = rand() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 1.5, 1 + rand() * 1.5);
  }
  // City grid — faint minor lines, slightly stronger arterials.
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 32) {
    ctx.strokeStyle = i % 128 === 0 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.022)";
    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, size);
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(size, i + 0.5);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(48, 48); // one tile ≈ 42 world units, arterial ≈ 10.5
  texture.anisotropy = 4;
  return texture;
}

/** Gradient sky dome — backside sphere, fog-exempt, drawn behind everything. */
function SkyDome() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uHorizon: { value: new THREE.Color(SKY_HORIZON) },
          uZenith: { value: new THREE.Color(SKY_ZENITH) },
          uFog: { value: new THREE.Color(DUSK_FOG) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uHorizon;
          uniform vec3 uZenith;
          uniform vec3 uFog;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float t = pow(clamp(d.y, 0.0, 1.0), 0.55);
            vec3 col = mix(uHorizon, uZenith, t);
            // Warm dusk band hugging the horizon.
            float band = pow(clamp(1.0 - abs(d.y - 0.05) * 5.0, 0.0, 1.0), 2.0);
            col += vec3(0.15, 0.075, 0.03) * band;
            // Below the horizon blend into the fog so the ground edge melts.
            col = mix(col, uFog, smoothstep(0.03, -0.1, d.y));
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[1200, 32, 16]} />
    </mesh>
  );
}

/**
 * OrbitControls + store-driven fly-to. Lives inside the keyed city group so
 * a fresh analysis remounts it — and the mount effect resets the camera to
 * the default overview (the rig remembers nothing across cities).
 */
function CameraRig({ buildings }: { buildings: Building[] }) {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const focusRequest = useCityStore((state) => state.focusRequest);
  const camera = useThree((state) => state.camera);

  const byId = useMemo(
    () => new Map(buildings.map((building) => [building.fileId, building])),
    [buildings],
  );

  interface Tween {
    t: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  }
  const tween = useRef<Tween | null>(null);

  // Fresh city → default overview (runs once per rig mount).
  useEffect(() => {
    camera.position.set(...OVERVIEW_POSITION);
    const controls = controlsRef.current;
    if (controls !== null) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new focusRequest (nonce changes even for repeat clicks) starts a tween.
  useEffect(() => {
    if (focusRequest === null) return;
    const controls = controlsRef.current;
    const building = byId.get(focusRequest.fileId);
    if (controls === null || building === undefined) return;

    const toTarget = new THREE.Vector3(
      building.x,
      Math.min(building.h * 0.55, 24),
      building.z,
    );
    // Keep the current viewing azimuth; pull to a reading distance.
    const distance = THREE.MathUtils.clamp(
      building.h * 1.6 + Math.max(building.w, building.d) * 3,
      24,
      90,
    );
    const direction = camera.position.clone().sub(controls.target).normalize();
    const toPos = toTarget.clone().add(direction.multiplyScalar(distance));
    toPos.y = Math.max(toPos.y, toTarget.y + distance * 0.45);

    tween.current = {
      t: 0,
      fromPos: camera.position.clone(),
      toPos,
      fromTarget: controls.target.clone(),
      toTarget,
    };
  }, [focusRequest, byId, camera]);

  // Any user gesture (drag/zoom/pan) cancels an in-flight tween immediately.
  useEffect(() => {
    const controls = controlsRef.current;
    if (controls === null) return;
    const cancel = (): void => {
      tween.current = null;
    };
    controls.addEventListener("start", cancel);
    return () => controls.removeEventListener("start", cancel);
  }, []);

  useFrame((_, delta) => {
    const active = tween.current;
    const controls = controlsRef.current;
    if (active === null || controls === null) return;
    active.t = Math.min(1, active.t + delta / FLY_DURATION);
    const eased = 1 - Math.pow(1 - active.t, 3); // ease-out cubic
    camera.position.lerpVectors(active.fromPos, active.toPos, eased);
    controls.target.lerpVectors(active.fromTarget, active.toTarget, eased);
    controls.update();
    if (active.t >= 1) tween.current = null;
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={MIN_DISTANCE}
      maxDistance={MAX_DISTANCE}
      minPolarAngle={MIN_POLAR}
      maxPolarAngle={MAX_POLAR}
    />
  );
}

export function CityScene({
  layout,
  changeSet,
}: {
  layout: CityLayout;
  /** Present only in compare modes (Phase 4) — drives hues but never geometry. */
  changeSet?: ChangeSet | null;
}) {
  const select = useCityStore((state) => state.select);
  const compareMap =
    changeSet === undefined || changeSet === null
      ? undefined
      : new Map(changeSet.changes.map((change) => [change.fileId, change]));

  const groundTexture = useMemo(() => makeGroundTexture(), []);
  useEffect(() => () => groundTexture?.dispose(), [groundTexture]);

  const shadowMapSize =
    layout.buildings.length > SHADOW_MAP_LOD_THRESHOLD ? 1024 : 2048;

  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ position: OVERVIEW_POSITION, fov: 50, near: 1, far: 3000 }}
      onPointerMissed={() => select(null)}
    >
      <color attach="background" args={[DUSK_FOG]} />
      <fogExp2 attach="fog" args={[DUSK_FOG, FOG_DENSITY]} />
      <SkyDome />

      {/* Lighting rig: warm key with shadows, cool hemisphere fill, cold rim. */}
      <hemisphereLight args={["#54627f", "#171a20", 0.55]} />
      <directionalLight
        position={[130, 190, 80]}
        intensity={2.0}
        color="#ffe7c4"
        castShadow
        shadow-mapSize={[shadowMapSize, shadowMapSize]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={20}
        shadow-camera-far={520}
        shadow-bias={-0.00035}
        shadow-normalBias={0.5}
      />
      <directionalLight position={[-140, 70, -110]} intensity={0.55} color="#7d9bff" />

      {/* Ground of the world — procedural asphalt/grid, receives shadows. */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[2000, 2000]} />
        <meshStandardMaterial
          color={groundTexture !== null ? "#ffffff" : "#14161c"}
          map={groundTexture ?? undefined}
          roughness={0.96}
          metalness={0}
        />
      </mesh>

      {/*
       * Keyed by repoPath + building count: analyzing a different folder (or
       * the same folder after files were added/removed) remounts the whole
       * city instead of patching instanced matrices in place. The CameraRig
       * sits inside the key so a fresh city also resets the viewpoint.
       */}
      <group key={`${layout.repoPath}:${layout.buildings.length}`}>
        <Districts districts={layout.districts} buildings={layout.buildings} />
        <Roads roads={layout.roads} buildings={layout.buildings} changes={compareMap} />
        <Buildings buildings={layout.buildings} changes={compareMap} />
        {changeSet !== undefined && changeSet !== null && (
          <ChangeOverlays layout={layout} changeSet={changeSet} />
        )}
        <CameraRig buildings={layout.buildings} />
      </group>

      {/*
       * Post: bloom is deliberately faint — only emissive channels (selection
       * glow, crane beacons, blast pulses) cross the threshold; the reserved
       * zinc city itself never blooms. SMAA replaces the Canvas' MSAA.
       */}
      <EffectComposer multisampling={0}>
        <Bloom
          mipmapBlur
          intensity={0.45}
          luminanceThreshold={0.55}
          luminanceSmoothing={0.25}
        />
        <Vignette offset={0.26} darkness={0.58} />
        <SMAA />
      </EffectComposer>
    </Canvas>
  );
}
