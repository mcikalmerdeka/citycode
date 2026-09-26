import { describe, expect, it } from "vitest";

import {
  ELEVATION_MAX,
  ELEVATION_MIN,
  SPAN_MAX,
  SPAN_MIN,
  clampedOrbit,
  envParams,
  layoutBounds,
  orbitPosition,
  orthoFrustum,
} from "@/components/city/orbitMath";
import type { CityLayout } from "@/lib/city/layout";

// ---------------------------------------------------------------------------
// orthoFrustum — span → symmetric orthographic frustum for a given aspect.
// ---------------------------------------------------------------------------

describe("orthoFrustum", () => {
  it("square aspect gives a symmetric span×span frustum", () => {
    expect(orthoFrustum(185, 1)).toEqual({
      left: -92.5,
      right: 92.5,
      top: 92.5,
      bottom: -92.5,
    });
  });

  it("wide aspect widens left/right, keeps top/bottom at span/2", () => {
    const f = orthoFrustum(100, 2);
    expect(f.top).toBeCloseTo(50);
    expect(f.bottom).toBeCloseTo(-50);
    expect(f.right).toBeCloseTo(100);
    expect(f.left).toBeCloseTo(-100);
  });

  it("tall aspect widens top/bottom, keeps left/right at span/2", () => {
    const f = orthoFrustum(100, 0.5);
    expect(f.left).toBeCloseTo(-50);
    expect(f.right).toBeCloseTo(50);
    expect(f.top).toBeCloseTo(100);
    expect(f.bottom).toBeCloseTo(-100);
  });

  it("scales linearly with span", () => {
    expect(orthoFrustum(320, 1).right).toBeCloseTo(160);
    expect(orthoFrustum(28, 1).right).toBeCloseTo(14);
  });
});

// ---------------------------------------------------------------------------
// orbitPosition — spherical (azimuth/elevation/distance) around a target.
// ---------------------------------------------------------------------------

describe("orbitPosition", () => {
  it("at elevation π/2 the camera sits straight above the target", () => {
    const p = orbitPosition({ x: 10, y: 2, z: -5 }, 0, Math.PI / 2, 50);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(52);
    expect(p.z).toBeCloseTo(-5);
  });

  it("at elevation 0 the camera sits level with the target at distance", () => {
    const p = orbitPosition({ x: 0, y: 0, z: 0 }, 0, 0, 100);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(100);
  });

  it("azimuth rotates the ground-plane offset", () => {
    const p = orbitPosition({ x: 0, y: 0, z: 0 }, Math.PI / 2, 0, 100);
    expect(p.x).toBeCloseTo(100);
    expect(p.z).toBeCloseTo(0);
  });

  it("overview pose angles: azimuth -0.32, elevation 0.66 (formula check at 185)", () => {
    const p = orbitPosition({ x: 0, y: 0, z: 0 }, -0.32, 0.66, 185);
    // cos(0.66)·185 ≈ 146.2 ground radius; sin(0.66)·185 ≈ 113.4 height.
    expect(p.y).toBeCloseTo(185 * Math.sin(0.66), 3);
    const ground = Math.hypot(p.x, p.z);
    expect(ground).toBeCloseTo(185 * Math.cos(0.66), 3);
    // azimuth -0.32 → x = sin(-0.32)·r, z = cos(-0.32)·r
    expect(p.x).toBeCloseTo(Math.sin(-0.32) * 185 * Math.cos(0.66), 3);
    expect(p.z).toBeCloseTo(Math.cos(-0.32) * 185 * Math.cos(0.66), 3);
  });

  it("distance is preserved from the target (spherical radius)", () => {
    const p = orbitPosition({ x: 5, y: 5, z: 5 }, 1.2, 0.8, 42);
    const radius = Math.hypot(p.x - 5, p.y - 5, p.z - 5);
    expect(radius).toBeCloseTo(42, 3);
  });
});

// ---------------------------------------------------------------------------
// clampedOrbit — elevation ∈ [0.45, 1.25] rad, span ∈ [28, 320].
// ---------------------------------------------------------------------------

describe("clampedOrbit", () => {
  it("keeps in-range values untouched", () => {
    expect(clampedOrbit(-0.32, 0.66, 185)).toEqual({
      azimuth: -0.32,
      elevation: 0.66,
      span: 185,
    });
  });

  it("clamps elevation below the minimum", () => {
    expect(clampedOrbit(0, 0.1, 100).elevation).toBe(ELEVATION_MIN);
  });

  it("clamps elevation above the maximum", () => {
    expect(clampedOrbit(0, 1.6, 100).elevation).toBe(ELEVATION_MAX);
  });

  it("clamps span below the minimum", () => {
    expect(clampedOrbit(0, 0.66, 5).span).toBe(SPAN_MIN);
  });

  it("clamps span above the maximum", () => {
    expect(clampedOrbit(0, 0.66, 900).span).toBe(SPAN_MAX);
  });

  it("clamps all three at once", () => {
    const c = clampedOrbit(-9, 9, 9);
    expect(c.azimuth).toBe(-9); // azimuth is unclamped (free spin)
    expect(c.elevation).toBe(ELEVATION_MAX);
    expect(c.span).toBe(SPAN_MIN);
  });

  it("clamp edges are inclusive", () => {
    expect(clampedOrbit(0, ELEVATION_MIN, SPAN_MAX)).toEqual({
      azimuth: 0,
      elevation: ELEVATION_MIN,
      span: SPAN_MAX,
    });
  });
});

// ---------------------------------------------------------------------------
// envParams — (phase, weather) → normalized uniform params for the scene.
// ---------------------------------------------------------------------------

describe("envParams", () => {
  it("noon + clear is the neutral baseline", () => {
    const p = envParams("noon", "clear");
    expect(p.night).toBe(0);
    expect(p.dusk).toBe(0);
    expect(p.lightsOn).toBe(0);
    expect(p.rain).toBe(0);
    expect(p.cloud).toBe(0);
    expect(p.wind).toBe(0);
    expect(p.wet).toBe(0);
  });

  it("sunset raises dusk to ~0.6 without night", () => {
    const p = envParams("sunset", "clear");
    expect(p.dusk).toBeCloseTo(0.6);
    expect(p.night).toBe(0);
    expect(p.lightsOn).toBe(0);
  });

  it("night is fully dark with lights on", () => {
    const p = envParams("night", "clear");
    expect(p.night).toBe(1);
    expect(p.lightsOn).toBe(1);
    expect(p.dusk).toBe(0);
  });

  it("morning carries a light dusk tint", () => {
    const p = envParams("morning", "clear");
    expect(p.dusk).toBeCloseTo(0.2);
    expect(p.night).toBe(0);
    expect(p.lightsOn).toBe(0);
  });

  it("cloudy weather raises cloud only", () => {
    const p = envParams("noon", "cloudy");
    expect(p.cloud).toBe(1);
    expect(p.rain).toBe(0);
    expect(p.wet).toBe(0);
  });

  it("rain raises rain, cloud and wet together", () => {
    const p = envParams("noon", "rain");
    expect(p.rain).toBe(1);
    expect(p.cloud).toBe(1);
    expect(p.wet).toBe(1);
  });

  it("every phase×weather combination yields all seven keys in [0,1]", () => {
    const phases = ["morning", "noon", "sunset", "night"] as const;
    const weathers = ["clear", "cloudy", "rain"] as const;
    for (const phase of phases) {
      for (const weather of weathers) {
        const p = envParams(phase, weather);
        for (const key of [
          "night",
          "dusk",
          "lightsOn",
          "rain",
          "cloud",
          "wind",
          "wet",
        ] as const) {
          const v = p[key];
          expect(v, `${phase}/${weather}/${key}`).toBeGreaterThanOrEqual(0);
          expect(v, `${phase}/${weather}/${key}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// layoutBounds — the axis-aligned rect covering every building in a layout.
// ---------------------------------------------------------------------------

/** Minimal layout factory for bounds tests (only buildings matter). */
function makeLayout(
  buildings: Array<{ x: number; z: number; w: number; d: number }>,
): CityLayout {
  return {
    buildings: buildings.map((b, i) => ({ ...b, fileId: `f${i}`, h: 1 })),
    districts: [],
    roads: [],
    repoPath: "test",
  };
}

describe("layoutBounds", () => {
  it("empty layout falls back to the default 200×200 root rect", () => {
    expect(layoutBounds(makeLayout([]))).toEqual({
      minX: -100,
      maxX: 100,
      minZ: -100,
      maxZ: 100,
    });
  });

  it("covers every building footprint", () => {
    const b = layoutBounds(
      makeLayout([
        { x: 10, z: 20, w: 4, d: 6 },
        { x: -30, z: -8, w: 10, d: 2 },
      ]),
    );
    // Building 1: x ∈ [8, 12], z ∈ [17, 23]; building 2: x ∈ [-35, -25], z ∈ [-9, -7]
    expect(b.minX).toBeCloseTo(-35);
    expect(b.maxX).toBeCloseTo(12);
    expect(b.minZ).toBeCloseTo(-9);
    expect(b.maxZ).toBeCloseTo(23);
  });

  it("single centered building gives a tight rect", () => {
    const b = layoutBounds(makeLayout([{ x: 0, z: 0, w: 8, d: 8 }]));
    expect(b.minX).toBeCloseTo(-4);
    expect(b.maxX).toBeCloseTo(4);
    expect(b.minZ).toBeCloseTo(-4);
    expect(b.maxZ).toBeCloseTo(4);
  });
});
