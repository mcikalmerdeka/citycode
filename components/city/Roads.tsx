"use client";

/**
 * Roads — street tarmac batched into merged ribbon meshes: asphalt, cream
 * curbs, and dashed center markings, each group ONE merged mesh (instead of
 * thousands of 1px drei <Line>s).
 *
 * Geometry decision (measured, documented per the Phase 3D brief): flat
 * mitered RIBBONS, not TubeGeometry. A ribbon segment costs 2 triangles; a
 * tube at even 6 radial segments costs 12+ and rounds a shape that should
 * read as tarmac. With ~36 corridors the whole street grid is a few thousand
 * triangles in three draw calls — trivially inside the frame budget.
 *
 * Routing: tarmac comes from the street corridors of
 * {@link deriveStreetNetwork} (layout → pure geometry). The layout's import
 * edges are NOT drivable and are never drawn as roads; they only reach this
 * component to derive the import-route ACCENT — corridors crossed by an
 * import route are overpainted with a thin routeAccent strip, the one
 * data-encoding colour. There is no blast tinting on corridors (compare
 * emphasis lives in ChangeOverlays + the accent).
 *
 * Diorama look (Small World reference): dark asphalt (#4A4844), cream curbs
 * hugging both street sides, static white dashed center markings (#ECE7DC)
 * via a uv-based dash shader — no time uniform, nothing animates.
 *
 * Elevation: the lawn ground plane sits at y=0 (Environment), buildings at
 * y=0 — roads float just above the lawn at 0.08 with polygonOffset so they
 * never z-fight, and sit below the district curb tops (0.18) so curbs read
 * as raised edges between street and block.
 *
 * Roads stay non-interactive: no pointer handlers, so R3F never raycasts
 * them.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { Building, Road } from "@/lib/city/layout";
import { routeRoad } from "@/lib/city/layout";
import type { StreetNetwork } from "@/lib/city/streets";
import { GROUND_COLORS } from "@/lib/city/theme";

const ROAD_COLOR = GROUND_COLORS.road;
const CROSSWALK_COLOR = GROUND_COLORS.crosswalk;
/** Zebra crossings: stripe length (along travel), stripe width, gap, setback. */
const ZEBRA_LENGTH = 2.2;
const ZEBRA_STRIPE = 0.55;
const ZEBRA_GAP = 0.55;
const ZEBRA_SETBACK = 0.9;
const CURB_COLOR = GROUND_COLORS.curb;
const MARKING_COLOR = GROUND_COLORS.marking;
const ROUTE_COLOR = GROUND_COLORS.routeAccent;
/** Ribbon elevation — just above the lawn (y=0), below district curb tops. */
const ROAD_Y = 0.08;
/** Curbs/markings ride a hair above the asphalt to avoid z-fighting. */
const CURB_Y = 0.1;
const MARKING_Y = 0.11;
/** Route accent rides above the asphalt, below the markings. */
const ROUTE_Y = 0.12;
/** Curb strip profile: thin raised edge just outside the asphalt edge. */
const CURB_WIDTH = 0.5;
const CURB_INSET = 0.15;
/** Center marking dash: dash length/gap along uv.x (world units). */
const DASH_LENGTH = 2.2;
const DASH_GAP = 2.2;

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

/** Append one flat axis-aligned quad (y-up) to a ribbon accumulator. */
function appendQuad(
  data: RibbonData,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  y: number,
): void {
  const base = data.positions.length / 3;
  data.positions.push(minX, y, minZ, maxX, y, minZ, minX, y, maxZ, maxX, y, maxZ);
  data.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
  data.uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
  data.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
}

/**
 * Zebra crossings on every arm of every intersection: stripes run along the
 * travel direction and are laid across the full carriageway, set back just
 * past the crossing box. An arm only gets a crossing when its corridor
 * actually continues that way.
 */
function appendCrosswalks(streets: StreetNetwork, y: number, data: RibbonData): void {
  const find = (axis: "x" | "z", center: number, along: number) =>
    streets.corridors.find(
      (c) => c.axis === axis && Math.abs(c.center - center) < 1e-3 && along >= c.from - 1e-3 && along <= c.to + 1e-3,
    );
  for (const node of streets.intersections) {
    const ns = find("x", node.x, node.z); // runs along Z
    const ew = find("z", node.z, node.x); // runs along X
    if (ns === undefined || ew === undefined) continue;
    const pitch = ZEBRA_STRIPE + ZEBRA_GAP;
    // North/south arms: crossing spans X across the NS carriageway.
    for (const dir of [-1, 1]) {
      const start = node.z + dir * (ew.width / 2 + ZEBRA_SETBACK);
      const end = start + dir * ZEBRA_LENGTH;
      if (Math.min(start, end) < ns.from || Math.max(start, end) > ns.to) continue;
      const count = Math.floor((ns.width - ZEBRA_GAP) / pitch);
      const offset = node.x - (count * pitch - ZEBRA_GAP) / 2;
      for (let i = 0; i < count; i++) {
        const x0 = offset + i * pitch;
        appendQuad(data, x0, x0 + ZEBRA_STRIPE, Math.min(start, end), Math.max(start, end), y);
      }
    }
    // East/west arms: crossing spans Z across the EW carriageway.
    for (const dir of [-1, 1]) {
      const start = node.x + dir * (ns.width / 2 + ZEBRA_SETBACK);
      const end = start + dir * ZEBRA_LENGTH;
      if (Math.min(start, end) < ew.from || Math.max(start, end) > ew.to) continue;
      const count = Math.floor((ew.width - ZEBRA_GAP) / pitch);
      const offset = node.z - (count * pitch - ZEBRA_GAP) / 2;
      for (let i = 0; i < count; i++) {
        const z0 = offset + i * pitch;
        appendQuad(data, Math.min(start, end), Math.max(start, end), z0, z0 + ZEBRA_STRIPE, y);
      }
    }
  }
}

export function Roads({
  streets,
  roads,
  buildings,
}: {
  /** The derived street network — corridors become the tarmac. */
  streets: StreetNetwork;
  /** Import edges — used ONLY to derive the route accent overlay. */
  roads: Road[];
  buildings: Building[];
}) {
  const { tarmacGeometry, curbGeometry, markingGeometry, accentGeometry, crosswalkGeometry } = useMemo(() => {
    const byId = new Map(buildings.map((building) => [building.fileId, building]));
    const tarmacData = emptyRibbon();
    const curbData = emptyRibbon();
    const markingData = emptyRibbon();
    const accentData = emptyRibbon();

    // ---- Tarmac, curbs and markings: one ribbon per street corridor.
    for (const corridor of streets.corridors) {
      const polyline =
        corridor.axis === "x"
          ? [
              { x: corridor.center, z: corridor.from },
              { x: corridor.center, z: corridor.to },
            ]
          : [
              { x: corridor.from, z: corridor.center },
              { x: corridor.to, z: corridor.center },
            ];
      appendRibbon(polyline, ROAD_Y, corridor.width, tarmacData);
      // Curbs hug both asphalt edges.
      const edge = corridor.width / 2 + CURB_INSET;
      appendRibbon(
        offsetPolyline(polyline, edge),
        CURB_Y,
        CURB_WIDTH,
        curbData,
      );
      appendRibbon(
        offsetPolyline(polyline, -edge),
        CURB_Y,
        CURB_WIDTH,
        curbData,
      );
      // Dashed center markings run the full corridor in every mode.
      appendRibbon(polyline, MARKING_Y, 0.28, markingData);
    }

    // ---- Import-route accent: corridors crossed by an import edge's L-route
    // get a thin accent strip. The route is derived render-side (pure) from
    // the buildings; each route waypoint marks the corridors it lands on —
    // one strip per touched corridor, no double paints.
    const touched = new Set<string>();
    for (const road of roads) {
      const from = byId.get(road.fromId);
      const to = byId.get(road.toId);
      if (from === undefined || to === undefined) continue;
      for (const waypoint of routeRoad(from, to)) {
        for (const corridor of streets.corridors) {
          const across =
            corridor.axis === "x"
              ? waypoint.x - corridor.center
              : waypoint.z - corridor.center;
          const along =
            corridor.axis === "x" ? waypoint.z : waypoint.x;
          if (
            Math.abs(across) <= corridor.width / 2 &&
            along >= corridor.from &&
            along <= corridor.to
          ) {
            touched.add(
              `${corridor.axis}-${corridor.center}-${corridor.from}-${corridor.to}`,
            );
          }
        }
      }
    }
    const keyFor = (corridor: StreetNetwork["corridors"][number]): string =>
      `${corridor.axis}-${corridor.center}-${corridor.from}-${corridor.to}`;
    for (const corridor of streets.corridors) {
      if (!touched.has(keyFor(corridor))) continue;
      const polyline =
        corridor.axis === "x"
          ? [
              { x: corridor.center, z: corridor.from },
              { x: corridor.center, z: corridor.to },
            ]
          : [
              { x: corridor.from, z: corridor.center },
              { x: corridor.to, z: corridor.center },
            ];
      appendRibbon(polyline, ROUTE_Y, corridor.width * 0.3, accentData);
    }

    const crosswalkData = emptyRibbon();
    appendCrosswalks(streets, MARKING_Y, crosswalkData);

    return {
      tarmacGeometry: buildGeometry(tarmacData),
      curbGeometry: buildGeometry(curbData),
      markingGeometry: buildGeometry(markingData),
      accentGeometry: buildGeometry(accentData),
      crosswalkGeometry: buildGeometry(crosswalkData),
    };
  }, [streets, roads, buildings]);

  useEffect(
    () => () => {
      tarmacGeometry?.dispose();
      curbGeometry?.dispose();
      markingGeometry?.dispose();
      accentGeometry?.dispose();
      crosswalkGeometry?.dispose();
    },
    [tarmacGeometry, curbGeometry, markingGeometry, accentGeometry, crosswalkGeometry],
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
             if (dash < 0.5) discard;
           }`,
        );
    },
    [],
  );

  return (
    <group>
      {tarmacGeometry !== null && (
        <mesh geometry={tarmacGeometry} receiveShadow dispose={null}>
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
      {crosswalkGeometry !== null && (
        <mesh geometry={crosswalkGeometry} receiveShadow dispose={null}>
          <meshStandardMaterial
            color={CROSSWALK_COLOR}
            roughness={0.85}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
          />
        </mesh>
      )}
      {accentGeometry !== null && (
        <mesh geometry={accentGeometry} dispose={null}>
          <meshStandardMaterial
            color={ROUTE_COLOR}
            roughness={0.85}
            metalness={0}
            side={THREE.DoubleSide}
            transparent
            opacity={0.85}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
          />
        </mesh>
      )}
    </group>
  );
}
