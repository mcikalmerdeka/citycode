"use client";

/**
 * Simulation — the living layer of the diorama: pedestrians strolling the
 * sidewalk graph, vehicles driving the road network with car-following
 * queuing, and trees dotted over the open lawn.
 *
 * Render model (performance contract): ZERO per-frame React renders. The
 * headless sim (`lib/sim/*`) owns all agent state; this component reads it
 * each frame and writes instance matrices directly — one draw call per part
 * (ped body, ped head, vehicle body, cabin, trunk, canopy). Instance colors
 * are written once at mount; React re-renders only when the city changes
 * (keyed remount upstream) or phase/weather/simEnabled change.
 *
 * Timestep: a fixed-step accumulator (STEP from lib/sim/engine, at most
 * MAX_STEPS_PER_FRAME per frame, rawDelta clamped to 0.1) keeps the sim
 * independent of display refresh and safe after background-tab pauses.
 *
 * Environment contract: this component is the ONLY caller of
 * `stepEnvUniforms` — it eases the module-level `envUniforms` toward
 * `envParams(timeOfDay, weather)` inside the accumulator loop, and feeds the
 * eased live `rain` value into `stepSim` so traffic slows as rain fades in.
 * (Buildings/lighting consume the reactive `EnvParams` prop instead; the
 * singleton is the sim's smooth view of the weather.)
 *
 * Trees: deterministic LCG placement over the bounds rect plus a skirt that
 * still sits on the lawn/slab, rejecting district rects, building
 * footprints, road clearances, and each other (min spacing). Canopies sway
 * with the wind uniform; trunks stay planted.
 */

import { useEffect, useMemo, useRef, useLayoutEffect } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { Building, District } from "@/lib/city/layout";
import {
  SIM_COLORS,
  TREE_COLORS,
  type DayPhase,
  type Weather,
} from "@/lib/city/theme";
import {
  MAX_STEPS_PER_FRAME,
  STEP,
  createSim,
  stepSim,
  type SimState,
} from "@/lib/sim/engine";
import { envUniforms, resetEnvUniforms, stepEnvUniforms } from "@/lib/sim/daycycle";
import { pedPosition } from "@/lib/sim/pedestrians";
import { vehiclePosition } from "@/lib/sim/vehicles";
import type { PathNetwork } from "@/lib/sim/types";

import type { LayoutBounds } from "./orbitMath";
import { envParams } from "./orbitMath";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Trees also sprinkle this far beyond the building rect (stays on the lawn). */
const TREE_MARGIN = 12;
/** Average tree density: one tree per this many square world units. */
const TREE_AREA_PER_TREE = 90;
/** Hard cap so a huge city can't spawn an unreasonable forest. */
const TREE_MAX = 400;
/** Placement attempts per target tree before giving up on a slot. */
const TREE_ATTEMPT_FACTOR = 10;
/** Trees keep this much clearance from district edges / building walls. */
const TREE_DISTRICT_SETBACK = 1.2;
const TREE_BUILDING_SETBACK = 1.5;
/** Trees keep this much clearance from road centerlines. */
const TREE_ROAD_CLEARANCE = 4.5;
/** Minimum spacing between two trees (world units). */
const TREE_SPACING = 6;
/** Tree scale range. */
const TREE_SCALE_MIN = 0.8;
const TREE_SCALE_RANGE = 0.5;
/** Share of canopies that get the autumn tone. */
const TREE_AUTUMN_RATIO = 0.18;

/** Ped rig heights: capsule body center, sphere head center, walk-bob amplitude. */
const PED_BODY_Y = 0.95;
const PED_HEAD_Y = 1.75;
const PED_BOB = 0.09;
/** Vehicle rig: body box center height; cabin local offset above/behind. */
const VEH_BODY_Y = 0.75;
const VEH_CABIN_DY = 0.83;
const VEH_CABIN_DZ = -0.35;
/** Canopy sway: max tilt (radians) at full wind. */
const TREE_SWAY = 0.04;

// ---------------------------------------------------------------------------
// Deterministic placement helpers
// ---------------------------------------------------------------------------

interface TreePlacement {
  x: number;
  z: number;
  scale: number;
  autumn: boolean;
}

/** Deterministic LCG rand — same construction as Environment's lawn speckle. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** Squared distance from point p to segment a→b (t clamped to the segment). */
function segmentDistanceSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) {
    const ex = px - ax;
    const ez = pz - az;
    return ex * ex + ez * ez;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq));
  const ex = px - (ax + dx * t);
  const ez = pz - (az + dz * t);
  return ex * ex + ez * ez;
}

/** Point is strictly inside the rect expanded by `setback` on every side. */
function insideRect(
  x: number,
  z: number,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
  setback: number,
): boolean {
  return (
    x > cx - halfW - setback &&
    x < cx + halfW + setback &&
    z > cz - halfD - setback &&
    z < cz + halfD + setback
  );
}

/**
 * Deterministic tree placement over the open lawn. Same inputs → byte-identical
 * placements (fixed-seed LCG, no Math.random, no environment reads).
 */
function placeTrees(
  bounds: LayoutBounds,
  districts: District[],
  buildings: Building[],
  roads: PathNetwork["roads"],
): TreePlacement[] {
  const minX = bounds.minX - TREE_MARGIN;
  const maxX = bounds.maxX + TREE_MARGIN;
  const minZ = bounds.minZ - TREE_MARGIN;
  const maxZ = bounds.maxZ + TREE_MARGIN;
  const area = (maxX - minX) * (maxZ - minZ);
  const target = Math.min(TREE_MAX, Math.floor(area / TREE_AREA_PER_TREE));
  if (target <= 0) return [];

  // Flatten road polylines once for the clearance check.
  const roadSegments: Array<[number, number, number, number]> = [];
  for (const road of roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      roadSegments.push([a.x, a.z, b.x, b.z]);
    }
  }

  const rand = lcg(0x5eed1a7e);
  const placed: TreePlacement[] = [];
  const attempts = target * TREE_ATTEMPT_FACTOR;
  const spacingSq = TREE_SPACING * TREE_SPACING;
  const roadClearSq = TREE_ROAD_CLEARANCE * TREE_ROAD_CLEARANCE;

  for (let i = 0; i < attempts && placed.length < target; i++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    let blocked = false;
    for (const district of districts) {
      if (
        insideRect(
          x, z, district.x, district.z, district.w / 2, district.d / 2,
          TREE_DISTRICT_SETBACK,
        )
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const building of buildings) {
      if (
        insideRect(
          x, z, building.x, building.z, building.w / 2, building.d / 2,
          TREE_BUILDING_SETBACK,
        )
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const [ax, az, bx, bz] of roadSegments) {
      if (segmentDistanceSq(x, z, ax, az, bx, bz) < roadClearSq) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const tree of placed) {
      const dx = tree.x - x;
      const dz = tree.z - z;
      if (dx * dx + dz * dz < spacingSq) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    placed.push({
      x,
      z,
      scale: TREE_SCALE_MIN + rand() * TREE_SCALE_RANGE,
      autumn: rand() < TREE_AUTUMN_RATIO,
    });
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Sim construction helpers
// ---------------------------------------------------------------------------

/** Per-city sim seed: FNV-1a over the repo path — stable per city. */
function seedFor(repoPath: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < repoPath.length; i++) {
    hash ^= repoPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Adaptive agent counts: scale with the network, clamped to sane bounds. */
function countsFor(
  nodeCount: number,
  roadCount: number,
): { pedestrians: number; vehicles: number } {
  return {
    pedestrians: Math.round(Math.min(220, Math.max(40, nodeCount / 2))),
    vehicles: Math.round(Math.min(30, Math.max(6, roadCount / 8))),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Simulation({
  network,
  repoPath,
  timeOfDay,
  weather,
  bounds,
  districts,
  buildings,
  simEnabled,
}: {
  network: PathNetwork;
  repoPath: string;
  timeOfDay: DayPhase;
  weather: Weather;
  bounds: LayoutBounds;
  districts: District[];
  buildings: Building[];
  simEnabled: boolean;
}) {
  // The sim owns all agent state — created once per city (keyed remount
  // upstream guarantees a fresh mount per repo/layout change).
  const sim = useMemo<SimState>(
    () =>
      createSim(
        network,
        seedFor(repoPath),
        countsFor(network.sidewalk.nodes.length, network.roads.length),
      ),
    [network, repoPath],
  );

  const trees = useMemo(
    () => placeTrees(bounds, districts, buildings, network.roads),
    [bounds, districts, buildings, network.roads],
  );

  // Tree geometry is baked with its local Y offsets (trunk 0→2.6, canopy
  // centered at 3.35) so instance matrices can pivot sways at the base.
  const treeGeometry = useMemo(() => {
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 2.6, 6);
    trunk.translate(0, 1.3, 0);
    const canopy = new THREE.SphereGeometry(1.7, 10, 8);
    canopy.translate(0, 3.35, 0);
    return { trunk, canopy };
  }, []);
  useEffect(
    () => () => {
      treeGeometry.trunk.dispose();
      treeGeometry.canopy.dispose();
    },
    [treeGeometry],
  );

  // Env uniform target — eased per fixed step inside the accumulator.
  const envTarget = useRef(envParams(timeOfDay, weather));
  useEffect(() => {
    envTarget.current = envParams(timeOfDay, weather);
  }, [timeOfDay, weather]);

  // Fresh city (remount) starts from neutral uniforms; leaving zeroes them
  // so the next city doesn't inherit a soaked midnight.
  useEffect(() => {
    resetEnvUniforms();
    return () => resetEnvUniforms();
  }, []);

  const pedBodyRef = useRef<THREE.InstancedMesh>(null);
  const pedHeadRef = useRef<THREE.InstancedMesh>(null);
  const vehBodyRef = useRef<THREE.InstancedMesh>(null);
  const vehCabinRef = useRef<THREE.InstancedMesh>(null);
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const canopyRef = useRef<THREE.InstancedMesh>(null);
  const accumulator = useRef(0);
  /** Last heading per ped (radians) — persists while dwelling. Ref, not
   * state: the useFrame hot path mutates it, React never reads it. */
  const pedHeadings = useRef(new Float32Array(0));

  // Scratch objects — reused every frame, never allocated in the hot path.
  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      euler: new THREE.Euler(),
      unit: new THREE.Vector3(1, 1, 1),
      treeScale: new THREE.Vector3(),
    }),
    [],
  );

  // Instance colors: written once (shirts/skins/vehicle bodies never change).
  useLayoutEffect(() => {
    const color = new THREE.Color();
    const bodies = pedBodyRef.current;
    const heads = pedHeadRef.current;
    if (bodies !== null) {
      for (let i = 0; i < sim.peds.length; i++) {
        color.set(SIM_COLORS.shirts[sim.peds[i].shirt % SIM_COLORS.shirts.length]);
        bodies.setColorAt(i, color);
      }
      if (bodies.instanceColor !== null) bodies.instanceColor.needsUpdate = true;
    }
    if (heads !== null) {
      for (let i = 0; i < sim.peds.length; i++) {
        color.set(SIM_COLORS.skins[sim.peds[i].skin % SIM_COLORS.skins.length]);
        heads.setColorAt(i, color);
      }
      if (heads.instanceColor !== null) heads.instanceColor.needsUpdate = true;
    }
    const vehBodies = vehBodyRef.current;
    if (vehBodies !== null) {
      for (let i = 0; i < sim.vehs.length; i++) {
        color.set(
          SIM_COLORS.vehicleBody[sim.vehs[i].id % SIM_COLORS.vehicleBody.length],
        );
        vehBodies.setColorAt(i, color);
      }
      if (vehBodies.instanceColor !== null) vehBodies.instanceColor.needsUpdate = true;
    }
  }, [sim]);

  // Tree canopy tones: mostly sage, some autumn, slight per-tree value jitter.
  useLayoutEffect(() => {
    const canopies = canopyRef.current;
    if (canopies === null) return;
    const rand = lcg(0xcafe5eed);
    const color = new THREE.Color();
    for (let i = 0; i < trees.length; i++) {
      color.set(trees[i].autumn ? TREE_COLORS.canopyAutumn : TREE_COLORS.canopySage);
      color.multiplyScalar(0.92 + rand() * 0.16);
      canopies.setColorAt(i, color);
    }
    if (canopies.instanceColor !== null) canopies.instanceColor.needsUpdate = true;
  }, [trees]);

  // Base instance matrices (trunks static, canopies straight) before any sway.
  useLayoutEffect(() => {
    const trunks = trunkRef.current;
    const canopies = canopyRef.current;
    if (trunks === null || canopies === null) return;
    const { matrix, pos, quat, treeScale } = scratch;
    quat.identity();
    for (let i = 0; i < trees.length; i++) {
      pos.set(trees[i].x, 0, trees[i].z);
      treeScale.setScalar(trees[i].scale);
      matrix.compose(pos, quat, treeScale);
      trunks.setMatrixAt(i, matrix);
      canopies.setMatrixAt(i, matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
  }, [trees, scratch]);

  useFrame((_, rawDelta) => {
    if (!simEnabled) {
      accumulator.current = 0;
      return;
    }

    // --- Fixed-timestep accumulator (background-tab safe). ---
    const delta = Math.min(rawDelta, 0.1);
    accumulator.current += delta;
    let steps = 0;
    while (accumulator.current >= STEP && steps < MAX_STEPS_PER_FRAME) {
      stepEnvUniforms(envTarget.current, STEP);
      stepSim(sim, STEP, envUniforms.rain);
      accumulator.current -= STEP;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator.current = 0; // drop backlog

    const { matrix, pos, quat, euler, unit, treeScale } = scratch;

    // --- Pedestrians: position + heading + walk bob. ---
    const pedBodies = pedBodyRef.current;
    const pedHeads = pedHeadRef.current;
    if (pedBodies !== null && pedHeads !== null) {
      const nodes = sim.network.sidewalk.nodes;
      if (pedHeadings.current.length !== sim.peds.length) {
        pedHeadings.current = new Float32Array(sim.peds.length);
      }
      const headings = pedHeadings.current;
      for (let i = 0; i < sim.peds.length; i++) {
        const ped = sim.peds[i];
        const position = pedPosition(ped, sim.network.sidewalk);
        const moving = ped.dwell <= 0 && ped.leg < ped.path.length - 1;
        let heading = headings[i] ?? 0;
        if (moving) {
          const from = nodes[ped.path[ped.leg]];
          const to = nodes[ped.path[ped.leg + 1]];
          if (from !== undefined && to !== undefined) {
            heading = Math.atan2(to.x - from.x, to.z - from.z);
            headings[i] = heading;
          }
        }
        const bob = moving
          ? Math.abs(Math.sin(sim.time * ped.speed * 2.2 + ped.id)) * PED_BOB
          : 0;
        euler.set(0, heading, 0);
        quat.setFromEuler(euler);
        pos.set(position.x, PED_BODY_Y + bob, position.z);
        matrix.compose(pos, quat, unit);
        pedBodies.setMatrixAt(i, matrix);
        pos.set(position.x, PED_HEAD_Y + bob, position.z);
        matrix.compose(pos, quat, unit);
        pedHeads.setMatrixAt(i, matrix);
      }
      pedBodies.instanceMatrix.needsUpdate = true;
      pedHeads.instanceMatrix.needsUpdate = true;
    }

    // --- Vehicles: body + cabin (cabin rides a rotated local offset). ---
    const vehBodies = vehBodyRef.current;
    const vehCabins = vehCabinRef.current;
    if (vehBodies !== null && vehCabins !== null) {
      for (let i = 0; i < sim.vehs.length; i++) {
        const vp = vehiclePosition(sim.vehs[i], sim.roadGraph);
        euler.set(0, vp.angle, 0);
        quat.setFromEuler(euler);
        pos.set(vp.x, VEH_BODY_Y, vp.z);
        matrix.compose(pos, quat, unit);
        vehBodies.setMatrixAt(i, matrix);
        const sin = Math.sin(vp.angle);
        const cos = Math.cos(vp.angle);
        pos.set(
          vp.x + VEH_CABIN_DZ * sin,
          VEH_BODY_Y + VEH_CABIN_DY,
          vp.z + VEH_CABIN_DZ * cos,
        );
        matrix.compose(pos, quat, unit);
        vehCabins.setMatrixAt(i, matrix);
      }
      vehBodies.instanceMatrix.needsUpdate = true;
      vehCabins.instanceMatrix.needsUpdate = true;
    }

    // --- Tree sway: canopy tilts pivot at the trunk base (baked geometry). ---
    const canopies = canopyRef.current;
    if (canopies !== null && envUniforms.wind > 0.005) {
      for (let i = 0; i < trees.length; i++) {
        const sway =
          Math.sin(sim.time * 1.3 + i * 1.7) * envUniforms.wind * TREE_SWAY;
        euler.set(sway, 0, sway * 0.7);
        quat.setFromEuler(euler);
        pos.set(trees[i].x, 0, trees[i].z);
        treeScale.setScalar(trees[i].scale);
        matrix.compose(pos, quat, treeScale);
        canopies.setMatrixAt(i, matrix);
      }
      canopies.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group visible={simEnabled}>
      {sim.peds.length > 0 && (
        <>
          <instancedMesh
            ref={pedBodyRef}
            args={[undefined, undefined, sim.peds.length]}
            castShadow
            frustumCulled={false}
          >
            <capsuleGeometry args={[0.45, 0.7, 4, 8]} />
            <meshStandardMaterial roughness={0.85} metalness={0} />
          </instancedMesh>
          <instancedMesh
            ref={pedHeadRef}
            args={[undefined, undefined, sim.peds.length]}
            frustumCulled={false}
          >
            <sphereGeometry args={[0.34, 8, 8]} />
            <meshStandardMaterial roughness={0.7} metalness={0} />
          </instancedMesh>
        </>
      )}
      {sim.vehs.length > 0 && (
        <>
          <instancedMesh
            ref={vehBodyRef}
            args={[undefined, undefined, sim.vehs.length]}
            castShadow
            frustumCulled={false}
          >
            <boxGeometry args={[1.9, 1.1, 4.2]} />
            <meshStandardMaterial roughness={0.5} metalness={0.15} />
          </instancedMesh>
          <instancedMesh
            ref={vehCabinRef}
            args={[undefined, undefined, sim.vehs.length]}
            castShadow
            frustumCulled={false}
          >
            <boxGeometry args={[1.6, 0.55, 2.1]} />
            <meshStandardMaterial color="#3A3630" roughness={0.35} metalness={0.1} />
          </instancedMesh>
        </>
      )}
      {trees.length > 0 && (
        <>
          <instancedMesh
            ref={trunkRef}
            args={[undefined, undefined, trees.length]}
            geometry={treeGeometry.trunk}
            castShadow
            frustumCulled={false}
          >
            <meshStandardMaterial color={TREE_COLORS.trunk} roughness={0.9} metalness={0} />
          </instancedMesh>
          <instancedMesh
            ref={canopyRef}
            args={[undefined, undefined, trees.length]}
            geometry={treeGeometry.canopy}
            castShadow
            frustumCulled={false}
          >
            <meshStandardMaterial roughness={0.85} metalness={0} />
          </instancedMesh>
        </>
      )}
    </group>
  );
}
