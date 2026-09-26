"use client";

/**
 * The 3D city view — an R3F Canvas rendering a {@link CityLayout} verbatim
 * (no client-side re-derivation of geometry) plus the living simulation
 * layer (pedestrians/vehicles/trees, see Simulation.tsx).
 *
 * Visual contract (Small World diorama): warm lawn ground on a stacked
 * wooden slab, soft warm key light, flat page-color backdrop. Color stays
 * reserved for compare modes; the only hue exception is the selection
 * highlight (see Buildings.tsx).
 *
 * Camera model (orbitMath.ts): an orthographic camera orbits a target point
 * on a sphere; "zoom" changes the orthographic frustum size (`span`) instead
 * of raw camera movement, so buildings stay parallel-edged at every zoom —
 * the model-not-a-world look. Custom pointer controls (NOT drei
 * OrbitControls, which fight the span-driven frustum):
 * - left-drag  → pan the target across the ground plane
 * - wheel      → zoom (span)
 * - right-drag / ctrl+drag → orbit (azimuth + elevation, clamped)
 * All motion is exponentially damped; `prefers-reduced-motion` snaps
 * immediately. User input cancels any in-flight focus/reset tween.
 *
 * Lighting: one warm directional key from the upper-left with soft PCF
 * shadows covering the full root rect (260 half-extent, 2048 map), plus a gentle
 * warm/cool hemisphere fill. Color/intensity are modulated by
 * `envParams(timeOfDay, weather)` — sunset warms the key, night drops its
 * intensity and raises ambient so the diorama stays readable.
 *
 * No fog, no gradient sky dome, no post-processing: the diorama floats on
 * the flat page backdrop.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";

import type { Building, CityLayout } from "@/lib/city/layout";
import type { ChangeSet } from "@/lib/diff/apply";
import { derivePathNetwork } from "@/lib/city/paths";
import { PAGE_COLORS } from "@/lib/city/theme";
import { useCityStore } from "@/lib/store";

import { Buildings } from "./Buildings";
import { ChangeOverlays } from "./ChangeOverlays";
import { Districts } from "./Districts";
import { Roads } from "./Roads";
import { Simulation } from "./Simulation";
import { DioramaBase } from "./DioramaBase";
import { Environment } from "./Environment";
import {
  DEFAULT_ORBIT,
  ELEVATION_MAX,
  ELEVATION_MIN,
  SPAN_MAX,
  SPAN_MIN,
  clampedOrbit,
  envParams,
  layoutBounds,
  orbitPosition,
  orthoFrustum,
  type EnvParams,
  type OrbitState,
} from "./orbitMath";
import { SceneEnvContext } from "./sceneEnv";

/**
 * Camera distance from the target — arbitrary for an ortho camera (zoom is
 * the frustum span), but far enough that shadow-camera near/far and float
 * precision stay comfortable.
 */
const ORBIT_DISTANCE = 200;
/** Key-light shadow frustum half-extent: covers the ≈365×274 root rect
 * (half-diagonal ≈229) plus the slab overhang margin. */
const SHADOW_EXTENT = 260;
/** Shadow map resolution — the diorama look wants crisp soft edges. */
const SHADOW_MAP_SIZE = 2048;

/** Focus/reset tween duration (seconds). */
const FLY_DURATION = 0.8;
/** Per-frame damping rate for user-driven motion (higher = snappier). */
const DAMPING = 8;
/** Wheel zoom speed: fractional span change per pixel of wheel delta. */
const ZOOM_SPEED = 0.0016;
/** Orbit speed: radians per pixel of drag. */
const ORBIT_SPEED = 0.005;
/** Pan target clamp — keeps the city in view at max zoom-out. */
const PAN_LIMIT = 240;

/**
 * The lighting rig's response to the scene environment. Key-light color and
 * intensity, hemisphere colors, and ambient lift are all derived from the
 * normalized {@link EnvParams} so the diorama stays readable at night and
 * warms up at sunset.
 */
function lightingFor(env: EnvParams): {
  key: { color: string; intensity: number };
  hemi: { sky: string; ground: string; intensity: number };
  ambient: number;
} {
  // Sunset warms the key toward gold; night cools it toward moonlight.
  const keyColor = new THREE.Color("#fff3e0")
    .lerp(new THREE.Color("#ffd9a0"), env.dusk * 0.8)
    .lerp(new THREE.Color("#b9c8e8"), env.night * 0.85);
  // Overcast/rain dims the key; night drops it hard (windows take over).
  const keyIntensity =
    2.1 * (1 - env.night * 0.82) * (1 - env.cloud * 0.35) * (1 - env.rain * 0.15);
  // Sky/ground fill: warm cream ↔ cool slate, dimmed by overcast.
  const skyColor = new THREE.Color("#fdf6ec")
    .lerp(new THREE.Color("#cfd8e6"), env.night * 0.75)
    .lerp(new THREE.Color("#c9cdd4"), env.cloud * 0.5);
  const groundColor = new THREE.Color("#d8cbb4").lerp(
    new THREE.Color("#5a6472"),
    env.night * 0.7,
  );
  const hemiIntensity = 0.75 * (1 - env.cloud * 0.25);
  // Night raises ambient so walls/windows stay readable under the dim key.
  const ambient = 0.12 + env.night * 0.5 + env.cloud * 0.08;
  return {
    key: { color: `#${keyColor.getHexString()}`, intensity: keyIntensity },
    hemi: {
      sky: `#${skyColor.getHexString()}`,
      ground: `#${groundColor.getHexString()}`,
      intensity: hemiIntensity,
    },
    ambient,
  };
}

/**
 * Camera + controls + store-driven tweens. Lives inside the keyed city group
 * so a fresh analysis remounts it — and the mount effect resets the orbit to
 * the default overview (the rig remembers nothing across cities).
 */
function CameraRig({ buildings }: { buildings: Building[] }) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const focusRequest = useCityStore((state) => state.focusRequest);
  const resetViewRequest = useCityStore((state) => state.resetViewRequest);

  const byId = useMemo(
    () => new Map(buildings.map((building) => [building.fileId, building])),
    [buildings],
  );

  /** The authoritative orbit state — mutated in place, never re-rendered. */
  const orbit = useRef<OrbitState>({
    target: { ...DEFAULT_ORBIT.target },
    span: DEFAULT_ORBIT.span,
    azimuth: DEFAULT_ORBIT.azimuth,
    elevation: DEFAULT_ORBIT.elevation,
  });
  /** Damped values chasing `orbit` — what the camera actually renders. */
  const smooth = useRef<OrbitState>({
    target: { ...DEFAULT_ORBIT.target },
    span: DEFAULT_ORBIT.span,
    azimuth: DEFAULT_ORBIT.azimuth,
    elevation: DEFAULT_ORBIT.elevation,
  });
  /** Active store-driven tween, or null. */
  const tween = useRef<{ t: number; from: OrbitState; to: OrbitState } | null>(
    null,
  );
  /** Pointer-drag state (null = no relevant button held). */
  const drag = useRef<{ mode: "pan" | "orbit"; lastX: number; lastY: number } | null>(
    null,
  );

  // prefers-reduced-motion: damping snaps immediately.
  const reducedMotion = useRef(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = query.matches;
    const onChange = (event: MediaQueryListEvent): void => {
      reducedMotion.current = event.matches;
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  /**
   * Apply an orbit state to the ortho camera (position + frustum). The
   * camera comes from the frame callback's state (not a hook value) so the
   * per-frame mutation is legal.
   */
  const applyOrbit = (camera: THREE.Camera, state: OrbitState): void => {
    // Canvas is created with `orthographic` — the camera is always ortho.
    const ortho = camera as THREE.OrthographicCamera;
    const pos = orbitPosition(
      state.target,
      state.azimuth,
      state.elevation,
      ORBIT_DISTANCE,
    );
    camera.position.set(pos.x, pos.y, pos.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(state.target.x, state.target.y, state.target.z);
    const frustum = orthoFrustum(state.span, size.width / size.height);
    ortho.left = frustum.left;
    ortho.right = frustum.right;
    ortho.top = frustum.top;
    ortho.bottom = frustum.bottom;
    ortho.updateProjectionMatrix();
  };

  /** Start a tween from the current smoothed state toward `to`. */
  const startTween = useCallback((to: OrbitState): void => {
    const s = smooth.current;
    tween.current = {
      t: 0,
      from: {
        target: { ...s.target },
        span: s.span,
        azimuth: s.azimuth,
        elevation: s.elevation,
      },
      to: {
        target: { ...to.target },
        span: to.span,
        azimuth: to.azimuth,
        elevation: to.elevation,
      },
    };
  }, []);

  // The first useFrame applies the default pose — no mount effect needed
  // (smooth starts at DEFAULT_ORBIT, so frame 1 renders the overview).

  // A new focusRequest (nonce changes even for repeat clicks) starts a tween.
  useEffect(() => {
    if (focusRequest === null) return;
    const building = byId.get(focusRequest.fileId);
    if (building === undefined) return;

    // Keep the current viewing angles; pull to a reading span.
    const span = THREE.MathUtils.clamp(
      building.h * 1.5 + Math.max(building.w, building.d) * 3,
      SPAN_MIN,
      SPAN_MAX,
    );
    startTween({
      target: { x: building.x, y: Math.min(building.h * 0.55, 24), z: building.z },
      span,
      azimuth: smooth.current.azimuth,
      elevation: smooth.current.elevation,
    });
  }, [focusRequest, byId, startTween]);

  // resetViewRequest counter change → tween back to the default overview.
  useEffect(() => {
    if (resetViewRequest === 0) return;
    startTween({
      target: { ...DEFAULT_ORBIT.target },
      span: DEFAULT_ORBIT.span,
      azimuth: DEFAULT_ORBIT.azimuth,
      elevation: DEFAULT_ORBIT.elevation,
    });
  }, [resetViewRequest, startTween]);

  // ---- Pointer controls on the canvas element ----
  useEffect(() => {
    const element = gl.domElement;
    const cancelTween = (): void => {
      tween.current = null;
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button === 0 && !event.ctrlKey) {
        drag.current = { mode: "pan", lastX: event.clientX, lastY: event.clientY };
      } else if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
        drag.current = { mode: "orbit", lastX: event.clientX, lastY: event.clientY };
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      const state = drag.current;
      if (state === null) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      if (dx === 0 && dy === 0) return;
      cancelTween();
      const o = orbit.current;
      if (state.mode === "pan") {
        // Screen-space drag → ground-plane pan, rotated by the camera
        // azimuth and scaled by span/viewport-height so the grab is 1:1
        // (world units per screen pixel) at every zoom level.
        const scale = o.span / size.height;
        const sin = Math.sin(o.azimuth);
        const cos = Math.cos(o.azimuth);
        o.target.x -= (dx * cos + dy * sin) * scale;
        o.target.z += (dx * sin - dy * cos) * scale;
        o.target.y = 0;
        o.target.x = THREE.MathUtils.clamp(o.target.x, -PAN_LIMIT, PAN_LIMIT);
        o.target.z = THREE.MathUtils.clamp(o.target.z, -PAN_LIMIT, PAN_LIMIT);
      } else {
        o.azimuth -= dx * ORBIT_SPEED;
        o.elevation = THREE.MathUtils.clamp(
          o.elevation + dy * ORBIT_SPEED,
          ELEVATION_MIN,
          ELEVATION_MAX,
        );
      }
    };
    const onPointerUp = (): void => {
      drag.current = null;
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      cancelTween();
      const clamped = clampedOrbit(
        orbit.current.azimuth,
        orbit.current.elevation,
        orbit.current.span * (1 + event.deltaY * ZOOM_SPEED),
      );
      orbit.current.span = clamped.span;
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("contextmenu", onContextMenu);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("contextmenu", onContextMenu);
    };
    // size feeds the 1:1 pan scale; re-bind when it changes.
  }, [gl, size]);

  useFrame((frame, delta) => {
    const active = tween.current;
    if (active !== null) {
      active.t = Math.min(1, active.t + delta / FLY_DURATION);
      const eased = 1 - Math.pow(1 - active.t, 3); // ease-out cubic
      const o = orbit.current;
      o.target.x = THREE.MathUtils.lerp(active.from.target.x, active.to.target.x, eased);
      o.target.y = THREE.MathUtils.lerp(active.from.target.y, active.to.target.y, eased);
      o.target.z = THREE.MathUtils.lerp(active.from.target.z, active.to.target.z, eased);
      o.span = THREE.MathUtils.lerp(active.from.span, active.to.span, eased);
      o.azimuth = THREE.MathUtils.lerp(active.from.azimuth, active.to.azimuth, eased);
      o.elevation = THREE.MathUtils.lerp(
        active.from.elevation,
        active.to.elevation,
        eased,
      );
      if (active.t >= 1) tween.current = null;
    }

    // Damped chase: `smooth` follows `orbit` with exponential smoothing;
    // reduced motion snaps in a single frame.
    const k = reducedMotion.current ? 1 : 1 - Math.exp(-DAMPING * delta);
    const s = smooth.current;
    const o = orbit.current;
    s.target.x = THREE.MathUtils.lerp(s.target.x, o.target.x, k);
    s.target.y = THREE.MathUtils.lerp(s.target.y, o.target.y, k);
    s.target.z = THREE.MathUtils.lerp(s.target.z, o.target.z, k);
    s.span = THREE.MathUtils.lerp(s.span, o.span, k);
    s.azimuth = THREE.MathUtils.lerp(s.azimuth, o.azimuth, k);
    s.elevation = THREE.MathUtils.lerp(s.elevation, o.elevation, k);
    applyOrbit(frame.camera, s);
  });

  return null;
}

/** Warm/cool hemisphere + ambient + warm key light, modulated by env params. */
function Lighting({ env }: { env: EnvParams }) {
  const lighting = useMemo(() => lightingFor(env), [env]);
  return (
    <>
      <hemisphereLight
        args={[lighting.hemi.sky, lighting.hemi.ground, lighting.hemi.intensity]}
      />
      <ambientLight intensity={lighting.ambient} />
      <directionalLight
        position={[-60, 90, 40]}
        intensity={lighting.key.intensity}
        color={lighting.key.color}
        castShadow
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={20}
        shadow-camera-far={700}
        shadow-bias={-0.00035}
        shadow-normalBias={0.5}
      />
    </>
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
  const timeOfDay = useCityStore((state) => state.timeOfDay);
  const weather = useCityStore((state) => state.weather);
  const simEnabled = useCityStore((state) => state.simEnabled);
  const compareMap =
    changeSet === undefined || changeSet === null
      ? undefined
      : new Map(changeSet.changes.map((change) => [change.fileId, change]));

  const bounds = useMemo(() => layoutBounds(layout), [layout]);
  const env = useMemo(() => envParams(timeOfDay, weather), [timeOfDay, weather]);
  // Sim substrate (sidewalk graph + road polylines) — derived once per layout.
  const network = useMemo(() => derivePathNetwork(layout), [layout]);

  return (
    <Canvas
      orthographic
      shadows="percentage"
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 150, 180], near: 1, far: 3000, zoom: 1 }}
      onPointerMissed={() => select(null)}
    >
      <color attach="background" args={[PAGE_COLORS.backdrop]} />
      <SceneEnvContext.Provider value={env}>
        <Lighting env={env} />

        {/*
         * Keyed by repoPath + city group: analyzing a different folder (or
         * the same folder after files were added/removed) remounts the whole
         * city instead of patching instanced matrices in place. The
         * CameraRig sits inside the key so a fresh city also resets the
         * viewpoint.
         */}
        <group key={`${layout.repoPath}:${layout.buildings.length}`}>
          <Environment bounds={bounds} />
          <DioramaBase bounds={bounds} />
          <Districts districts={layout.districts} buildings={layout.buildings} />
          <Roads roads={layout.roads} buildings={layout.buildings} changes={compareMap} />
          <Buildings buildings={layout.buildings} changes={compareMap} envParams={env} />
          <Simulation
            network={network}
            repoPath={layout.repoPath}
            timeOfDay={timeOfDay}
            weather={weather}
            bounds={bounds}
            districts={layout.districts}
            buildings={layout.buildings}
            simEnabled={simEnabled}
          />
          {changeSet !== undefined && changeSet !== null && (
            <ChangeOverlays layout={layout} changeSet={changeSet} />
          )}
          <CameraRig buildings={layout.buildings} />
        </group>
      </SceneEnvContext.Provider>
    </Canvas>
  );
}
