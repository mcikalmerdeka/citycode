"use client";

/**
 * Buildings — the Small World warm-diorama restyle (Unit B).
 *
 * One instanced wall mesh per shape variant + ONE shared instanced roof mesh
 * (gable prisms), grouped into a small deterministic shape vocabulary, plus
 * overlay meshes for hover/selection. The instancing skeleton, hover /
 * selection mechanics, rise animation, LOD tiers and the data flow from
 * CityScene (`buildings` + `changes`) are preserved from the previous
 * renderer; only the LOOK changed.
 *
 * Diorama rules encoded here:
 * - Walls: cream/pale from BUILDING_COLORS with a subtle per-building
 *   lightness jitter (fileId hash) — never hue, never compare status.
 * - Roofs: terracotta mostly, slate ~20% (hash), on a separate instanced
 *   gable mesh so compare status can tint roofs via instanceColor without
 *   ever recoloring walls.
 * - Compare status: NEVER on walls. Status tints the roof (per-instance
 *   color via {@link compareAccent}) + a thin emissive base ring for
 *   construction/rubble. Static mode keeps pure terracotta/slate roofs.
 * - Windows: procedural world-space grid injected via onBeforeCompile; warm
 *   glow (#FFD98A-ish) driven by the night/dusk/lightsOn uniforms; rain/cloud
 *   darken walls slightly; wet darkens + saturates. Uniform values come from
 *   the optional `envParams` prop — CityScene will pass these via
 *   useSceneEnv() at Wave 2.1 integration (NOT this file's job); when the
 *   prop is absent, all-zero defaults render a neutral daytime diorama.
 * - Hover: subtle warm brightness lift (never cyan); selection: gentle
 *   emissive outline, tasteful for a light diorama.
 * - Fresh buildings (compare "added") rise from foundation height once over
 *   RISE_DURATION (unchanged mechanics).
 * - LOD tiers unchanged: past LOD_DETAIL_THRESHOLD the window shader and
 *   hover glow switch off; past LOD_SHADOW_THRESHOLD no shadows.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import { Instance, Instances, Outlines } from "@react-three/drei";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Building } from "@/lib/city/layout";
import type { NodeChange, NodeStatus } from "@/lib/diff/apply";
import { BUILDING_COLORS, COMPARE_ACCENTS } from "@/lib/city/theme";
import { useCityStore } from "@/lib/store";
import { compareAccent, roofRidgeOrientation } from "./compareAccent";

/**
 * Scene environment uniforms, consumed by the window/wall shader. CityScene
 * will pass these via useSceneEnv() at Wave 2.1 integration; when absent the
 * all-zero defaults render a neutral daytime diorama.
 */
export interface EnvParams {
  night: number;
  dusk: number;
  lightsOn: number;
  rain: number;
  cloud: number;
  wind: number;
  wet: number;
}

/** Neutral daytime defaults — every uniform at 0. */
const DEFAULT_ENV: EnvParams = {
  night: 0,
  dusk: 0,
  lightsOn: 0,
  rain: 0,
  cloud: 0,
  wind: 0,
  wet: 0,
};

/** Hover lift — warm near-white brightness, never cyan. */
const HOVER_EMISSIVE = "#f5ead6";
/** Selection outline — soft warm amber, tasteful on a light diorama. */
const SELECTED_EMISSIVE = "#e4a33c";
/** Overlay scale factor — just enough to clear the original faces. */
const SELECTION_SCALE = 1.02;

/**
 * Compare-status accents for the base outline ring (construction/rubble
 * only — roofs carry the tint). Kept as an export because Roads.tsx and
 * Legend.tsx mirror these status colors; the values now come from
 * COMPARE_ACCENTS so the diorama palette stays single-sourced.
 */
export const STATUS_COLORS: Record<NodeStatus, string> = {
  construction: COMPARE_ACCENTS.construction,
  fresh: COMPARE_ACCENTS.fresh,
  foundation: COMPARE_ACCENTS.foundation,
  rubble: COMPARE_ACCENTS.rubble,
  moved: COMPARE_ACCENTS.moved,
  blast: COMPARE_ACCENTS.blast,
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

/** Roof geometry: gable rise above the wall top, as a fraction of footprint. */
const ROOF_RISE = 0.22;

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
 *
 * Diorama re-proportion: volumes are lower and chunkier than the old
 * skyline — the height tiers compress toward the ground and the tall tier
 * caps lower, so pitched roofs stay readable on every silhouette.
 */
type Variant = 0 | 1 | 2; // 0 cottage · 1 gable-hall · 2 tall brick
function variantFor(building: Building): Variant {
  const hash = hashCode(building.fileId);
  if (building.h < 4) return 0;
  if (building.h < 12) return hash % 3 === 0 ? 0 : 1;
  return hash % 4 === 0 ? 1 : 2;
}

/**
 * The three normalized variant geometries: footprint 1×1 centered, base at
 * y=0, total height exactly 1 — instance scale [w, h, d] maps them onto the
 * layout with height semantics untouched. Diorama proportions: lower,
 * chunkier masses; the tall variant keeps a stepped silhouette but capped
 * lower, and its top tier is the redbrick accent band.
 */
function buildVariantGeometries(): [
  THREE.BufferGeometry,
  THREE.BufferGeometry,
  THREE.BufferGeometry,
] {
  const cottage = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const gableHall = mergeGeometries([
    new THREE.BoxGeometry(1, 0.72, 1).translate(0, 0.36, 0),
    new THREE.BoxGeometry(0.78, 0.28, 0.78).translate(0, 0.72 + 0.14, 0),
  ]);
  const tallBrick = mergeGeometries([
    new THREE.BoxGeometry(1, 0.6, 1).translate(0, 0.3, 0),
    new THREE.BoxGeometry(0.8, 0.28, 0.8).translate(0, 0.6 + 0.14, 0),
    new THREE.BoxGeometry(0.55, 0.12, 0.55).translate(0, 0.88 + 0.06, 0),
  ]);
  // mergeGeometries only fails on attribute mismatch (impossible for boxes) —
  // fall back to the cottage so the render can never degenerate.
  return [cottage, gableHall ?? cottage, tallBrick ?? cottage];
}

/**
 * ONE shared gable (triangular prism) roof geometry, unit footprint 1×1
 * centered at the origin, base at y=0, apex at y=1 — the ridge runs along
 * local X. Ridge orientation per building (x vs z) is chosen by hash via
 * {@link roofRidgeOrientation} and applied as a 90° instance rotation.
 */
function buildRoofGeometry(): THREE.BufferGeometry {
  // Prism via ExtrudeGeometry of a triangle in the XY plane, extruded along Z.
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(0, 1);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geometry.translate(0, 0, -0.5); // center the extrusion on the origin
  return geometry;
}

/**
 * Per-building wall color: one of five warm tones (hash pick) with a subtle
 * lightness jitter, so neighboring houses never read as clones. Pure function
 * of the fileId — deterministic across renders. Exported pure for tests.
 */
export function wallColorFor(fileId: string): string {
  const hash = hashCode(fileId);
  const base = BUILDING_COLORS.wallTones[hash % BUILDING_COLORS.wallTones.length];
  const jitter = ((hash >>> 8) % 9) - 4; // -4..+4 lightness steps
  const color = new THREE.Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + jitter * 0.012, 0, 1));
  return `#${color.getHexString()}`;
}

/**
 * Roof base color: terracotta dominant, ochre and slate as hash accents —
 * the reference diorama's roof mix. Pure function of the fileId.
 * Exported pure for tests.
 */
export function roofColorFor(fileId: string): string {
  const pick = hashCode(fileId) % 20;
  if (pick < 13) return BUILDING_COLORS.roofTerracotta;
  if (pick < 16) return BUILDING_COLORS.roofOchre;
  return BUILDING_COLORS.roofSlate;
}

/**
 * Per-building roof pitch multiplier (0.75–1.45 × the base rise) — cottages
 * and halls alternate between shallow and steep gables so no two roofs read
 * the same. Deterministic per fileId.
 */
function roofPitchFor(fileId: string): number {
  return 0.75 + ((hashCode(fileId) >>> 3) % 5) / 5 * 0.7;
}

/** Per-building roof rise in world units (pitch-varied, footprint-based). */
function roofRiseFor(building: Building): number {
  return Math.min(building.w, building.d) * ROOF_RISE * roofPitchFor(building.fileId);
}

/**
 * Procedural windows + environment response, injected into the shared wall
 * material via onBeforeCompile: SPARSE cottage-style windows on near-vertical
 * faces — a large world-space pitch with small panes and a per-cell presence
 * hash, so facades vary building to building instead of reading as a modern
 * office grid. By day the glass is barely darker than the wall (smooth warm
 * facades, like the reference); at dusk/night a minority of panes glow warm.
 * Rain/cloud darken walls slightly; wet darkens + slightly saturates.
 * Deterministic per world position (no clock, no Math.random), one compiled
 * program shared by all variants. Horizontal faces get a subtle value drop
 * so tops read apart.
 */
function injectWindows(
  shader: THREE.WebGLProgramParametersWithUniforms,
  env: EnvParams,
): void {
  shader.uniforms.cityNight = { value: env.night };
  shader.uniforms.cityDusk = { value: env.dusk };
  shader.uniforms.cityLightsOn = { value: env.lightsOn };
  shader.uniforms.cityRain = { value: env.rain };
  shader.uniforms.cityCloud = { value: env.cloud };
  shader.uniforms.cityWet = { value: env.wet };

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
       varying vec3 vCityWorldNormal;
       uniform float cityNight;
       uniform float cityDusk;
       uniform float cityLightsOn;
       uniform float cityRain;
       uniform float cityCloud;
       uniform float cityWet;`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       {
         vec3 cityNrm = normalize(vCityWorldNormal);
         if (abs(cityNrm.y) < 0.55) {
           // Vertical faces: sparse cottage windows in world space (never
           // stretch with the instance scale). Large pitch, small panes.
           float cityU = abs(cityNrm.x) > abs(cityNrm.z) ? vCityWorldPos.z : vCityWorldPos.x;
           float cityV = vCityWorldPos.y;
           float pu = fract(cityU / 3.1);
           float pv = fract(cityV / 3.4);
           float win = step(0.40, pu) * step(pu, 0.63) * step(0.36, pv) * step(pv, 0.62);
           // Per-cell hash: ~38% of cells have no window at all — each
           // building lands on a different pattern via its world offset.
           float cellId = floor(cityU / 3.1) * 131.0 + floor(cityV / 3.4) * 57.0;
           float rnd = fract(sin(cellId * 12.9898) * 43758.5453);
           win *= step(0.38, rnd);
           // Lit minority ramps up as evening falls / lights switch on.
           float litThreshold = mix(0.88, 0.45, max(cityDusk, max(cityNight, cityLightsOn)));
           float lit = step(litThreshold, rnd);
           float glow = win * lit * (0.3 + 0.7 * fract(rnd * 9.17));
           // Warm window glow (#FFD98A-ish), stronger at night.
           float nightBoost = 0.35 + 0.65 * max(cityDusk, max(cityNight, cityLightsOn));
           totalEmissiveRadiance += vec3(1.0, 0.85, 0.54) * glow * nightBoost * 0.9;
           // By day the glass reads barely darker than the wall.
           diffuseColor.rgb *= 1.0 - win * 0.10;
         } else {
           // Tops: subtle value drop so roof planes read apart from walls.
           diffuseColor.rgb *= 0.88;
         }
         // Weather response on the whole wall: rain/cloud darken slightly.
         diffuseColor.rgb *= 1.0 - 0.10 * max(cityRain, cityCloud);
         // Wet: darken + slightly saturate (rain sheen on the walls).
         float cityLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(cityLuma), cityWet * 0.35);
         diffuseColor.rgb *= 1.0 - 0.12 * cityWet;
       }`,
    );
}

/** Scratch objects for the fresh-rise matrix writes (module-level, reused). */
const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const tmpColor = new THREE.Color();

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

/** One roof instance: position/scale/rotation + base color + compare tint. */
interface RoofInstance {
  x: number;
  z: number;
  w: number;
  d: number;
  /** Roof base height (wall top) and rise — world units. */
  y: number;
  rise: number;
  rotate: boolean; // ridge along z instead of x
  color: string;
}

/**
 * Compose one roof instance's matrix. The base geometry is a unit 1×1 prism
 * with its ridge along local X; scale is applied in LOCAL space before the
 * rotation (compose = T·R·S), so a 90°-rotated instance must swap its x/z
 * scale or the roof footprint comes out transposed (d×w over a w×d building
 * — overhanging two walls, short on the other two). Rise stays vertical.
 */
function composeRoofMatrix(instance: RoofInstance, y: number): void {
  tmpMatrix.compose(
    tmpPosition.set(instance.x, y, instance.z),
    tmpQuaternion.setFromEuler(tmpEuler.set(0, instance.rotate ? Math.PI / 2 : 0, 0)),
    tmpScale.set(
      instance.rotate ? instance.d : instance.w,
      instance.rise,
      instance.rotate ? instance.w : instance.d,
    ),
  );
}

export function Buildings({
  buildings,
  changes,
  envParams,
}: {
  buildings: Building[];
  changes?: Map<string, NodeChange>;
  /**
   * Scene environment uniforms (night/dusk/lightsOn/rain/cloud/wind/wet).
   * CityScene passes these via useSceneEnv() at Wave 2.1 integration; when
   * absent, all-zero defaults render a neutral daytime diorama.
   */
  envParams?: EnvParams;
}) {
  const env = envParams ?? DEFAULT_ENV;
  const select = useCityStore((state) => state.select);
  const selectedId = useCityStore((state) => state.selectedId);
  const setHovered = useCityStore((state) => state.setHovered);
  const requestFocus = useCityStore((state) => state.requestFocus);

  const detailed = buildings.length <= LOD_DETAIL_THRESHOLD;
  const castShadow = buildings.length <= LOD_SHADOW_THRESHOLD;

  /** Rendered height: foundation status flattens; everything else keeps h. */
  const heightFor = useCallback(
    (building: Building): number =>
      changes?.get(building.fileId)?.status === "foundation"
        ? Math.min(building.h, FOUNDATION_H)
        : building.h,
    [changes],
  );

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

  const roofGeometry = useMemo(() => buildRoofGeometry(), []);
  useEffect(() => () => roofGeometry.dispose(), [roofGeometry]);

  /**
   * Roof instances: one per building, sitting on the wall top. Foundation
   * buildings get no roof (they are deliberately not-yet-buildings); fresh
   * buildings' roofs ride the rise animation via the same per-frame matrix
   * writes as the walls.
   */
  const roofInstances = useMemo<RoofInstance[]>(() => {
    const instances: RoofInstance[] = [];
    for (const building of buildings) {
      const status = changes?.get(building.fileId)?.status;
      if (status === "foundation") continue;
      const h = heightFor(building);
      const accent = compareAccent(
        useCityStore.getState().compareMode,
        status ?? "",
      );
      instances.push({
        x: building.x,
        z: building.z,
        w: building.w,
        d: building.d,
        y: h,
        rise: roofRiseFor(building),
        rotate: roofRidgeOrientation(building.fileId) === "z",
        color: accent.roofTint ?? roofColorFor(building.fileId),
      });
    }
    return instances;
    // compareMode is read via getState() so the memo stays keyed on the
    // layout/changes inputs; a mode switch re-renders the scene anyway.
  }, [buildings, changes, heightFor]);

  /**
   * Chimney instances: a hash-chosen ~45% of buildings get a small brick
   * stack poking through the roof ridge — the cottage detail that makes the
   * diorama read as houses instead of office blocks. Fully deterministic per
   * fileId; position rides the ridge line (x or z by roof orientation).
   */
  const chimneyInstances = useMemo(() => {
    const instances: Array<{
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      color: string;
    }> = [];
    for (const building of buildings) {
      if (changes?.get(building.fileId)?.status === "foundation") continue;
      const hash = hashCode(building.fileId);
      if (hash % 9 >= 4) continue;
      const rise = roofRiseFor(building);
      const rotate = roofRidgeOrientation(building.fileId) === "z";
      const min = Math.min(building.w, building.d);
      const side = min * (0.11 + ((hash >>> 7) % 10) / 200); // 0.11–0.16 × min side
      const height = Math.min(2.4, min * (0.26 + ((hash >>> 9) % 10) / 100));
      // Slide the stack along the ridge (±30% of half-length), on the ridge.
      const along = (((hash >>> 5) % 100) / 100 - 0.5) * 0.6;
      const ridge = rotate ? building.d : building.w;
      instances.push({
        x: building.x + (rotate ? 0 : along * ridge * 0.5),
        z: building.z + (rotate ? along * ridge * 0.5 : 0),
        y: building.h + rise * 0.4,
        w: side,
        h: height,
        color: BUILDING_COLORS.redbrick,
      });
    }
    return instances;
  }, [buildings, changes]);


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
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const chimneyRef = useRef<THREE.InstancedMesh>(null);
  const riseStart = useRef<number | null>(null);
  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const hoverRef = useRef<THREE.Mesh>(null);
  const selectionMaterialRef = useRef<THREE.MeshStandardMaterial>(null);

  /**
   * Roof instance index for a fresh-rise building — roofs are built in
   * buildings order (minus foundations), so the index is the count of roof
   * instances emitted before this building. Computed on the fly to avoid a
   * second map keyed by position.
   */
  const roofIndexFor = (x: number, z: number): number => {
    let index = 0;
    for (const instance of roofInstances) {
      if (instance.x === x && instance.z === z) return index;
      index++;
    }
    return -1;
  };

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
          // The roof rides on top of the rising walls.
          const roofMesh = roofRef.current;
          if (roofMesh !== null) {
            const roofIndex = roofIndexFor(anim.x, anim.z);
            if (roofIndex >= 0) {
              composeRoofMatrix(roofInstances[roofIndex], hNow);
              roofMesh.setMatrixAt(roofIndex, tmpMatrix);
              roofMesh.instanceMatrix.needsUpdate = true;
            }
          }
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
              roughness={0.92}
              metalness={0}
              onBeforeCompile={detailed ? (shader) => injectWindows(shader, env) : undefined}
            />
            {list.map((building) => {
              const h = heightFor(building);
              return (
                <Instance
                  key={building.fileId}
                  color={wallColorFor(building.fileId)}
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

      {/* ONE shared instanced roof mesh — gable prisms over every wall top. */}
      {roofInstances.length > 0 && (
        <instancedMesh
          key={roofInstances.length}
          ref={roofRef}
          args={[roofGeometry, undefined, roofInstances.length]}
          castShadow={castShadow}
          receiveShadow
        >
          <meshStandardMaterial roughness={0.9} metalness={0} />
        </instancedMesh>
      )}
      {/* Roof instance transforms + colors, written once per layout change. */}
      <RoofMatrices roofInstances={roofInstances} roofRef={roofRef} />

      {/* Brick chimney stacks — hash-picked minority, on the roof ridges. */}
      {chimneyInstances.length > 0 && (
        <instancedMesh
          key={chimneyInstances.length}
          ref={chimneyRef}
          args={[undefined, undefined, chimneyInstances.length]}
          castShadow={castShadow}
          frustumCulled={false}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial roughness={0.92} metalness={0} />
        </instancedMesh>
      )}
      <ChimneyMatrices chimneyInstances={chimneyInstances} chimneyRef={chimneyRef} />

      {/* Compare base rings — thin emissive outline at construction/rubble. */}
      {buildings.map((building) => {
        const status = changes?.get(building.fileId)?.status;
        const accent = compareAccent(
          useCityStore.getState().compareMode,
          status ?? "",
        );
        if (accent.outline === undefined) return null;
        return (
          <BaseRing
            key={`ring:${building.fileId}`}
            x={building.x}
            z={building.z}
            w={building.w}
            d={building.d}
            color={accent.outline}
          />
        );
      })}

      {/* Hover feedback — one shared mesh, repositioned per frame. */}
      <mesh ref={hoverRef} visible={false}>
        <boxGeometry />
        <meshStandardMaterial
          color={BUILDING_COLORS.wallCream}
          emissive={HOVER_EMISSIVE}
          emissiveIntensity={0.35}
          transparent
          opacity={detailed ? 0.28 : 0}
          depthWrite={false}
          roughness={0.92}
          metalness={0}
        />
        <Outlines thickness={0.03} color="#f0e8da" opacity={0.9} transparent />
      </mesh>

      {selected && (
        <group>
          {/* Selection glow — warm emissive over the diorama walls. */}
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
              color={BUILDING_COLORS.wallCream}
              emissive={SELECTED_EMISSIVE}
              emissiveIntensity={PULSE_BASE}
              roughness={0.92}
              metalness={0}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

/**
 * Writes the roof instanced mesh's matrices + instanceColors once per
 * roofInstances change (not per frame). Kept as a child component so the
 * writes happen after the mesh mounts, without a per-frame cost.
 */
function RoofMatrices({
  roofInstances,
  roofRef,
}: {
  roofInstances: RoofInstance[];
  roofRef: React.RefObject<THREE.InstancedMesh | null>;
}) {
  useEffect(() => {
    const mesh = roofRef.current;
    if (mesh === null) return;
    roofInstances.forEach((instance, index) => {
      composeRoofMatrix(instance, instance.y);
      mesh.setMatrixAt(index, tmpMatrix);
      tmpColor.set(instance.color);
      mesh.setColorAt(index, tmpColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [roofInstances, roofRef]);
  return null;
}

/**
 * Writes the chimney instanced mesh's matrices + instanceColors once per
 * chimneyInstances change (not per frame). Base-anchored unit box: position
 * y is the stack's base (buried in the roof), height scales upward.
 */
function ChimneyMatrices({
  chimneyInstances,
  chimneyRef,
}: {
  chimneyInstances: Array<{ x: number; y: number; z: number; w: number; h: number; color: string }>;
  chimneyRef: React.RefObject<THREE.InstancedMesh | null>;
}) {
  useEffect(() => {
    const mesh = chimneyRef.current;
    if (mesh === null) return;
    chimneyInstances.forEach((instance, index) => {
      tmpMatrix.compose(
        // Centered unit box — lift by half the height so instance.y is the base.
        tmpPosition.set(instance.x, instance.y + instance.h / 2, instance.z),
        tmpQuaternion.identity(),
        tmpScale.set(instance.w, instance.h, instance.w),
      );
      mesh.setMatrixAt(index, tmpMatrix);
      tmpColor.set(instance.color);
      mesh.setColorAt(index, tmpColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [chimneyInstances, chimneyRef]);
  return null;
}

/** Thin emissive ring at a building's base — compare-status ground emphasis. */
function BaseRing({ x, z, w, d, color }: { x: number; z: number; w: number; d: number; color: string }) {
  return (
    <mesh position={[x, 0.12, z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[Math.max(w, d) * 0.62, Math.max(w, d) * 0.72, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}