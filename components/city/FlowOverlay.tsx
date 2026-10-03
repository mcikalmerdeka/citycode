"use client";

/**
 * FlowOverlay — the guided demo inside the 3D city (Repo Guidance).
 *
 * While a demo is active it draws, on top of the untouched city:
 * - the route of every hop along the real street corridors (solid once the
 *   packet has used it, dashed while still ahead);
 * - a numbered badge above each stop's building (current / passed / ahead);
 * - a pulsing glow + ground ring on the current building;
 * - the data packet itself: it lifts off the previous building's roof, rides
 *   the streets to the next one with a short comet trail and a label naming
 *   the data it carries, and settles above the new building while the
 *   narration is read.
 *
 * It is also the demo's clock: every frame it calls tickFlow(), which
 * advances the playhead and keeps the store's discrete state in step. The
 * packet is positioned straight from the playhead (no React state per
 * frame), so playback never causes a render storm.
 *
 * The overlay never changes the city: no layout, no building recoloring —
 * everything here is additive and disappears when the demo stops.
 */

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";

import { routeRoad, type Building } from "@/lib/city/layout";
import { buildStreetGraph, type StreetGraph } from "@/lib/city/streetGraph";
import { routeAlongStreets, type StreetNetwork } from "@/lib/city/streets";
import { FLOW_COLORS } from "@/lib/city/theme";
import { tickFlow, useFlowStore, type ActiveFlow } from "@/lib/guidance/flowStore";
import { pointAlong, type Pt } from "@/lib/guidance/polyline";
import { easeInOut } from "@/lib/guidance/timeline";

/** Packet height while riding the streets. */
const STREET_Y = 1.7;
/** How far above a roof the packet hovers while a step is read. */
const ROOF_HOVER = 3;
/** Route lines float just above the curbs. */
const ROUTE_Y = 0.55;
/** Fraction of a hop spent lifting off / settling onto a roof. */
const LIFT_FRACTION = 0.18;
const TRAIL_LENGTH = 6;
const TRAIL_SPACING = 0.04;

const tmpPoint = new THREE.Vector3();

/** Route between two step buildings along the streets (Manhattan fallback). */
function hopPath(
  streets: StreetNetwork,
  graph: StreetGraph,
  from: Building | undefined,
  to: Building | undefined,
): Pt[] {
  if (from === undefined || to === undefined || from.fileId === to.fileId) return [];
  const routed = routeAlongStreets(streets, from, to, graph);
  return routed.length >= 2 ? routed : routeRoad(from, to);
}

/** Packet position at arc fraction `p` of a hop: roof → street level → roof. */
function packetAt(path: Pt[], p: number, roofFrom: number, roofTo: number, out: THREE.Vector3): THREE.Vector3 {
  const point = pointAlong(path, p);
  const lift = 1 - easeInOut(Math.min(1, p / LIFT_FRACTION));
  const settle = 1 - easeInOut(Math.min(1, (1 - p) / LIFT_FRACTION));
  const y = STREET_Y + (roofFrom - STREET_Y) * lift + (roofTo - STREET_Y) * settle;
  return out.set(point.x, y, point.z);
}

type StopState = "active" | "visited" | "upcoming";

function Badge({ numbers, state }: { numbers: number[]; state: StopState }) {
  const active = state === "active";
  return (
    <span
      className="select-none rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold leading-none shadow-md"
      style={{
        background: active ? FLOW_COLORS.route : "#FFFFFF",
        color: active ? FLOW_COLORS.badgeText : state === "visited" ? FLOW_COLORS.route : "#8A8A96",
        border: `1.5px solid ${state === "upcoming" ? FLOW_COLORS.upcoming : FLOW_COLORS.route}`,
        transform: active ? "scale(1.18)" : undefined,
      }}
    >
      {numbers.join("·")}
    </span>
  );
}

function ActiveFlowScene({
  flow,
  buildings,
  streets,
}: {
  flow: ActiveFlow;
  buildings: Building[];
  streets: StreetNetwork;
}) {
  const index = useFlowStore((state) => state.index);
  const phase = useFlowStore((state) => state.phase);

  const byId = useMemo(() => new Map(buildings.map((building) => [building.fileId, building])), [buildings]);
  const graph = useMemo(() => buildStreetGraph(streets), [streets]);
  const stops = useMemo(() => flow.steps.map((step) => byId.get(step.fileId)), [flow, byId]);
  const hops = useMemo(
    () => stops.map((stop, i) => (i === 0 ? [] : hopPath(streets, graph, stops[i - 1], stop))),
    [stops, streets, graph],
  );
  /** One entry per distinct building: the step numbers (1-based) it hosts. */
  const markers = useMemo(() => {
    const byFile = new Map<string, number[]>();
    flow.steps.forEach((step, i) => byFile.set(step.fileId, [...(byFile.get(step.fileId) ?? []), i + 1]));
    return [...byFile.entries()].flatMap(([fileId, numbers]) => {
      const building = byId.get(fileId);
      return building === undefined ? [] : [{ building, numbers }];
    });
  }, [flow, byId]);

  const packetRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.MeshStandardMaterial>(null);
  const trailRefs = useRef<Array<THREE.Mesh | null>>([]);

  useFrame(({ clock }, delta) => {
    const located = tickFlow(delta);
    if (located === null) return;
    const group = packetRef.current;
    const target = stops[located.index];
    if (group === null || target === undefined) return;
    const time = clock.elapsedTime;
    const trail = trailRefs.current;
    for (const mesh of trail) if (mesh !== null) mesh.visible = false;

    const path = hops[located.index] ?? [];
    const previous = located.index > 0 ? stops[located.index - 1] : undefined;
    const roofTo = target.h + ROOF_HOVER;
    if (located.phase === "hop" && path.length >= 2 && previous !== undefined) {
      const roofFrom = previous.h + ROOF_HOVER;
      const p = easeInOut(located.progress);
      packetAt(path, p, roofFrom, roofTo, tmpPoint);
      group.position.copy(tmpPoint);
      trail.forEach((mesh, k) => {
        if (mesh === null) return;
        const behind = p - (k + 1) * TRAIL_SPACING;
        if (behind <= 0) return;
        packetAt(path, behind, roofFrom, roofTo, tmpPoint);
        mesh.position.set(tmpPoint.x - group.position.x, tmpPoint.y - group.position.y, tmpPoint.z - group.position.z);
        mesh.scale.setScalar(1 - k / (TRAIL_LENGTH + 1));
        mesh.visible = true;
      });
    } else {
      // Resting (or a hop inside one building): hover above the roof, bobbing.
      const bounce = located.phase === "hop" ? Math.sin(located.progress * Math.PI) * 2.5 : 0;
      group.position.set(target.x, roofTo + Math.sin(time * 2.4) * 0.35 + bounce, target.z);
    }

    if (coreRef.current !== null) coreRef.current.rotation.y = time * 2.2;
    if (glowRef.current !== null) glowRef.current.opacity = 0.3 + 0.13 * Math.sin(time * 3.2);
  });

  const activeStop = stops[index];
  const payload = flow.steps[index]?.payload;

  return (
    <group>
      {hops.map((path, i) =>
        path.length < 2 ? null : (
          <Line
            key={`hop:${i}`}
            points={path.map((p): [number, number, number] => [p.x, ROUTE_Y, p.z])}
            color={i <= index ? FLOW_COLORS.route : FLOW_COLORS.upcoming}
            lineWidth={i <= index ? 3.2 : 2}
            dashed={i > index}
            dashSize={1.8}
            gapSize={1.5}
            transparent
            opacity={i <= index ? 0.9 : 0.55}
          />
        ),
      )}

      {markers.map(({ building, numbers }) => {
        const state: StopState = numbers.includes(index + 1)
          ? "active"
          : numbers[0]! - 1 < index
            ? "visited"
            : "upcoming";
        return (
          <group key={building.fileId}>
            <mesh position={[building.x, 0.3, building.z]} rotation-x={-Math.PI / 2}>
              <ringGeometry args={[Math.max(building.w, building.d) * 0.66, Math.max(building.w, building.d) * 0.78, 40]} />
              <meshBasicMaterial
                color={state === "upcoming" ? FLOW_COLORS.upcoming : FLOW_COLORS.route}
                transparent
                opacity={state === "active" ? 0.85 : 0.5}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <Html
              position={[building.x, building.h + 6.5, building.z]}
              center
              zIndexRange={[10, 0]}
              style={{ pointerEvents: "none" }}
            >
              <Badge numbers={numbers} state={state} />
            </Html>
          </group>
        );
      })}

      {activeStop !== undefined && (
        <mesh position={[activeStop.x, (activeStop.h * 1.02) / 2, activeStop.z]} scale={[activeStop.w * 1.06, activeStop.h * 1.02, activeStop.d * 1.06]}>
          <boxGeometry />
          <meshStandardMaterial
            ref={glowRef}
            color={FLOW_COLORS.route}
            emissive={FLOW_COLORS.route}
            emissiveIntensity={0.9}
            transparent
            opacity={0.35}
            depthWrite={false}
          />
        </mesh>
      )}

      <group ref={packetRef}>
        <mesh ref={coreRef}>
          <octahedronGeometry args={[1.1, 0]} />
          <meshStandardMaterial color={FLOW_COLORS.route} emissive={FLOW_COLORS.route} emissiveIntensity={1.5} roughness={0.3} />
        </mesh>
        <mesh>
          <sphereGeometry args={[2, 16, 16]} />
          <meshBasicMaterial color={FLOW_COLORS.glow} transparent opacity={0.26} depthWrite={false} />
        </mesh>
        {Array.from({ length: TRAIL_LENGTH }, (_, k) => (
          <mesh
            key={k}
            visible={false}
            ref={(mesh: THREE.Mesh | null) => {
              trailRefs.current[k] = mesh;
            }}
          >
            <sphereGeometry args={[0.8, 10, 10]} />
            <meshBasicMaterial color={FLOW_COLORS.glow} transparent opacity={0.5} depthWrite={false} />
          </mesh>
        ))}
        {phase === "hop" && payload !== undefined && (
          <Html position={[0, 3.6, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
            <span
              className="whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium shadow-md"
              style={{ background: FLOW_COLORS.route, color: FLOW_COLORS.badgeText }}
            >
              {payload}
            </span>
          </Html>
        )}
      </group>
    </group>
  );
}

export function FlowOverlay({ buildings, streets }: { buildings: Building[]; streets: StreetNetwork }) {
  const flow = useFlowStore((state) => state.flow);
  if (flow === null) return null;
  return <ActiveFlowScene flow={flow} buildings={buildings} streets={streets} />;
}
