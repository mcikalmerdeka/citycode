"use client";

/**
 * Roads — warm diorama tarmac batched into merged ribbon meshes: asphalt,
 * cream curbs, and dashed center markings, each group ONE merged mesh
 * (instead of thousands of 1px drei <Line>s).
 *
 * Geometry decision (measured, documented per the Phase 3D brief): flat
 * mitered RIBBONS, not TubeGeometry. A ribbon segment costs 2 triangles; a
 * tube at even 6 radial segments costs 12+ and rounds a shape that should
 * read as tarmac. With ~3k edges × ≤4 waypoints the whole road network is
 * ~25k triangles in four draw calls — trivially inside the frame budget.
 *
 * Routing: waypoints come from the pure {@link routeRoad} helper (Manhattan
 * L-routes trimmed to building footprint edges) — deterministic per edge, so
 * the street grid is stable for a given layout. The layout's own road data
 * (center-to-center) is untouched; re-routing is a render-time concern.
 *
 * Diorama look (Small World reference): warm gray asphalt (#77746F), cream
 * curbs hugging both road sides, and static white dashed center markings
 * (#ECE7DC) via a uv-based dash shader — no time uniform, so markings never
 * animate. Blast-radius roads (compare mode; the importer side — fromId —
 * carries the "blast" status) keep a slow emissive pulse traveling along the
 * ribbon via a shared uTime uniform, retinted to the warm COMPARE_ACCENTS
 * blast red instead of the old pure red.
 *
 * Elevation: the lawn ground plane sits at y=0 (Environment), buildings at
 * y=0 — roads float just above the lawn at 0.08 with polygonOffset so they
 * never z-fight, and sit below the district curb tops (0.18) so curbs read
 * as raised edges between street and block.
 *
 * Roads stay non-interactive: no pointer handlers, so R3F never raycasts
 * them.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { Building, Road } from "@/lib/city/layout";
import { routeRoad } from "@/lib/city/layout";
import type { NodeChange } from "@/lib/diff/apply";
import { COMPARE_ACCENTS, GROUND_COLORS } from "@/lib/city/theme";

const ROAD_COLOR = GROUND_COLORS.asphalt;
const CURB_COLOR = GROUND_COLORS.curb;
const MARKING_COLOR = GROUND_COLORS.marking;
/** Ribbon elevation — just above the lawn (y=0), below district curb tops. */
const ROAD_Y = 0.08;
/** Curbs/markings ride a hair above the asphalt to avoid z-fighting. */
const CURB_Y = 0.1;
const MARKING_Y = 0.11;
const ROAD_WIDTH = 3.2;
const BLAST_ROAD_WIDTH = 3.6;
/** Curb strip profile: thin raised edge just outside the asphalt edge. */
const CURB_WIDTH = 0.5;
const CURB_INSET = 0.15;
/** Center marking dash: dash length/gap along uv.x (world units). */
const DASH_LENGTH = 2.2;
const DASH_GAP = 2.2;
/** Traveling-pulse speed (world units/s) and period (world units). */
const DASH_SPEED = 8;
const DASH_PERIOD = 10;

/** Accumulators for one merged ribbon mesh. */
interface RibbonData {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function emptyRibbon(): RibbonData {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/**
 * Append one polyline as a mitered flat ribbon (two vertices per waypoint,
 * triangle-strip indexed). Miter joins are clamped so 90° Manhattan corners
 * stay crisp without spikes; degenerate (zero-length) polylines are skipped
 * defensively, same contract as the old renderer.
 */
function appendRibbon(
  points: Array<{ x: number; z: number }>,
  y: number,
  width: number,
  data: RibbonData,
): void {
  if (points.length < 2) return;

  const dirs: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dz = points[i + 1].z - points[i].z;
    const length = Math.hypot(dx, dz);
    if (length === 0) return;
    dirs.push({ x: dx / length, z: dz / length });
  }

  const half = width / 2;
  const base = data.positions.length / 3;
  let cumulative = 0;

  for (let j = 0; j < points.length; j++) {
    let perpX: number;
    let perpZ: number;
    if (j === 0) {
      perpX = -dirs[0].z;
      perpZ = dirs[0].x;
    } else if (j === points.length - 1) {
      const dir = dirs[dirs.length - 1];
      perpX = -dir.z;
      perpZ = dir.x;
    } else {
      const prev = dirs[j - 1];
      const next = dirs[j];
      let miterX = -prev.z + -next.z;
      let miterZ = prev.x + next.x;
      const miterLength = Math.hypot(miterX, miterZ);
      if (miterLength < 1e-6) {
        miterX = -prev.z;
        miterZ = prev.x;
      } else {
        miterX /= miterLength;
        miterZ /= miterLength;
      }
      const dot = miterX * -prev.z + miterZ * prev.x;
      const scale = Math.min(3, 1 / Math.max(0.3, Math.abs(dot)));
      perpX = miterX * scale;
      perpZ = miterZ * scale;
    }
    if (j > 0) {
      cumulative += Math.hypot(points[j].x - points[j - 1].x, points[j].z - points[j - 1].z);
    }
    data.positions.push(
      points[j].x + perpX * half,
      y,
      points[j].z + perpZ * half,
      points[j].x - perpX * half,
      y,
      points[j].z - perpZ * half,
    );
    data.normals.push(0, 1, 0, 0, 1, 0);
    data.uvs.push(cumulative, 0, cumulative, 1);
  }

  for (let j = 0; j < points.length - 1; j++) {
    const a = base + j * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    data.indices.push(a, c, b, b, c, d);
  }
}

function buildGeometry(data: RibbonData): THREE.BufferGeometry | null {
  if (data.indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setIndex(data.indices);
  return geometry;
}

/**
 * Offset a polyline perpendicular to its direction — the same Manhattan-axis
 * normal rule as lib/city/paths.ts (prev/next waypoint difference). Used to
 * lay the curb strips just outside the asphalt edge on both sides.
 */
function offsetPolyline(
  points: Array<{ x: number; z: number }>,
  offset: number,
): Array<{ x: number; z: number }> {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const length = Math.hypot(dx, dz);
    if (length === 0) {
      out.push({ ...points[i] });
      continue;
    }
    out.push({
      x: points[i].x + (-dz / length) * offset,
      z: points[i].z + (dx / length) * offset,
    });
  }
  return out;
}

export function Roads({
  roads,
  buildings,
  changes,
}: {
  roads: Road[];
  buildings: Building[];
  /** Compare status per fileId — only the "blast" flag is read here. */
  changes?: Map<string, NodeChange>;
}) {
  const { staticGeometry, blastGeometry, curbGeometry, markingGeometry } = useMemo(() => {
    const byId = new Map(buildings.map((building) => [building.fileId, building]));
    const staticData = emptyRibbon();
    const blastData = emptyRibbon();
    const curbData = emptyRibbon();
    const markingData = emptyRibbon();
    for (const road of roads) {
      const from = byId.get(road.fromId);
      const to = byId.get(road.toId);
      if (from === undefined || to === undefined) continue;
      const waypoints = routeRoad(from, to);
      // Blast emphasis derives from the IMPORTER side (fromId), mirroring
      // how Buildings recolors the same status.
      const blast = changes?.get(road.fromId)?.status === "blast";
      const width = blast ? BLAST_ROAD_WIDTH : ROAD_WIDTH;
      appendRibbon(waypoints, ROAD_Y, width, blast ? blastData : staticData);
      // Curbs hug both asphalt edges (no ribbon over a blast pulse — curbs
      // stay cream in every mode).
      const edge = width / 2 + CURB_INSET;
      appendRibbon(offsetPolyline(waypoints, edge), CURB_Y, CURB_WIDTH, curbData);
      appendRibbon(offsetPolyline(waypoints, -edge), CURB_Y, CURB_WIDTH, curbData);
      // Dashed center markings run the full polyline in every mode.
      appendRibbon(waypoints, MARKING_Y, 0.28, markingData);
    }
    return {
      staticGeometry: buildGeometry(staticData),
      blastGeometry: buildGeometry(blastData),
      curbGeometry: buildGeometry(curbData),
      markingGeometry: buildGeometry(markingData),
    };
  }, [roads, buildings, changes]);

  useEffect(
    () => () => {
      staticGeometry?.dispose();
      blastGeometry?.dispose();
      curbGeometry?.dispose();
      markingGeometry?.dispose();
    },
    [staticGeometry, blastGeometry, curbGeometry, markingGeometry],
  );

  // One shared time uniform drives every blast pulse; reduced-motion users
  // get a frozen (still visible) emphasis instead of a traveling one.
  const dashTime = useRef({ value: 0 });
  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  useFrame((_, delta) => {
    if (!reducedMotion.current) dashTime.current.value += delta;
  });

  const injectBlastDash = useMemo(
    () => (shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uTime = dashTime.current;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vRoadUv;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvRoadUv = uv;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uTime;\nvarying vec2 vRoadUv;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
           {
             float m = fract((vRoadUv.x - uTime * ${DASH_SPEED.toFixed(1)}) / ${DASH_PERIOD.toFixed(1)});
             float dash = 1.0 - smoothstep(0.3, 0.35, m);
             totalEmissiveRadiance += vec3(1.0, 0.36, 0.3) * dash * 1.4;
           }`,
        );
    },
    [],
  );

  // Static dashed center markings: uv.x is cumulative path length, so a
  // plain fract step paints dashes — no time uniform, nothing animates.
  const injectMarkingDash = useMemo(
    () => (shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vRoadUv;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvRoadUv = uv;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vRoadUv;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
           {
             float m = fract(vRoadUv.x / ${ (DASH_LENGTH + DASH_GAP).toFixed(1) });
             float dash = step(${(DASH_LENGTH / (DASH_LENGTH + DASH_GAP)).toFixed(3)}, m);
             diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.25, 1.0 - dash);
           }`,
        );
    },
    [],
  );

  return (
    <group>
      {staticGeometry !== null && (
        <mesh geometry={staticGeometry} receiveShadow dispose={null}>
          <meshStandardMaterial
            color={ROAD_COLOR}
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}
      {blastGeometry !== null && (
        <mesh geometry={blastGeometry} receiveShadow dispose={null}>
          <meshStandardMaterial
            color={COMPARE_ACCENTS.blast}
            roughness={0.9}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
            onBeforeCompile={injectBlastDash}
          />
        </mesh>
      )}
      {curbGeometry !== null && (
        <mesh geometry={curbGeometry} receiveShadow dispose={null}>
          <meshStandardMaterial
            color={CURB_COLOR}
            roughness={0.85}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}
      {markingGeometry !== null && (
        <mesh geometry={markingGeometry} dispose={null}>
          <meshStandardMaterial
            color={MARKING_COLOR}
            roughness={0.9}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
            onBeforeCompile={injectMarkingDash}
          />
        </mesh>
      )}
    </group>
  );
}
