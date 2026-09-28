import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { computeCityStats, StatsBar } from "@/components/ui/StatsBar";
import { ViewControls } from "@/components/ui/ViewControls";
import type { CityLayout } from "@/lib/city/layout";
import { useCityStore } from "@/lib/store";

// ---------------------------------------------------------------------------
// Unit E — DOM shell restyle. The vitest suite runs in a node environment and
// @testing-library/react is not a dependency, so component behavior is
// verified two ways: pure logic helpers directly, and static SSR markup
// (renderToStaticMarkup via createElement — no JSX, the vitest include is
// tests/**/*.test.ts). Store wiring is asserted through the zustand store.
// ---------------------------------------------------------------------------

function makeLayout(overrides: Partial<CityLayout> = {}): CityLayout {
  return {
    buildings: [
      { fileId: "a.ts", x: 0, z: 0, w: 1, d: 1, h: 10 },
      { fileId: "b.ts", x: 2, z: 0, w: 1, d: 1, h: 20 },
    ],
    districts: [{ path: "lib", x: 1, z: 0, w: 4, d: 2, depth: 0, label: "lib" }],
    roads: [{ fromId: "a.ts", toId: "b.ts", points: [{ x: 0, z: 0 }, { x: 2, z: 0 }] }],
    repoPath: "/repo",
    ...overrides,
  };
}

describe("computeCityStats", () => {
  it("counts files, districts, import edges and streets from the layout", () => {
    const stats = computeCityStats(makeLayout());
    // The 4x2 fixture is too small for a ring (inset 3 > half-extent), so it
    // has zero street corridors — the field still reports.
    expect(stats).toEqual({ files: 2, districts: 1, roads: 1, streets: 0 });
  });

  it("returns zeros for an empty city", () => {
    const stats = computeCityStats(
      makeLayout({ buildings: [], districts: [], roads: [] }),
    );
    expect(stats).toEqual({ files: 0, districts: 0, roads: 0, streets: 0 });
  });
});

describe("StatsBar render", () => {
  it("renders the counts as bold values with gray labels", () => {
    const html = renderToStaticMarkup(createElement(StatsBar, { layout: makeLayout() }));
    expect(html).toContain("2");
    expect(html).toContain("files");
    expect(html).toContain("1");
    expect(html).toContain("districts");
    expect(html).toContain("streets");
    expect(html).toContain("stat-pill");
    expect(html).toContain("stat-value");
  });
});

describe("ViewControls store wiring", () => {
  beforeEach(() => {
    useCityStore.setState({
      timeOfDay: "noon",
      weather: "clear",
      resetViewRequest: 0,
    });
  });

  it("renders reset + every day phase and weather option", () => {
    const html = renderToStaticMarkup(createElement(ViewControls));
    expect(html).toContain("Reset view");
    for (const label of ["Morning", "Noon", "Sunset", "Night", "Clear", "Cloudy", "Rain"]) {
      expect(html).toContain(label);
    }
  });

  it("marks the active day phase and weather with aria-pressed", () => {
    // Note: renderToStaticMarkup goes through React's SSR path, where zustand
    // serves getInitialState() — so the rendered "active" options are always
    // the store's creation defaults (noon / clear), regardless of setState.
    // Active-state switching itself is covered by the store tests below.
    const html = renderToStaticMarkup(createElement(ViewControls));
    const pressed = html.match(/aria-pressed="true"[^>]*>([^<]+)</g) ?? [];
    const pressedLabels = pressed.map((m) => m.replace(/.*>([^<]+)</, "$1"));
    expect(pressedLabels).toEqual(["Noon", "Clear"]);
    // Every option carries an explicit aria-pressed (a11y contract).
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(7);
  });

  it("requestResetView increments the store counter (the Reset view handler)", () => {
    expect(useCityStore.getState().resetViewRequest).toBe(0);
    useCityStore.getState().requestResetView();
    expect(useCityStore.getState().resetViewRequest).toBe(1);
  });

  it("setTimeOfDay / setWeather switch the store values (the selector handlers)", () => {
    useCityStore.getState().setTimeOfDay("night");
    useCityStore.getState().setWeather("cloudy");
    expect(useCityStore.getState().timeOfDay).toBe("night");
    expect(useCityStore.getState().weather).toBe("cloudy");
  });
});

describe("slim street display", () => {
  it("Roads renders street corridors instead of import-edge polylines", () => {
    const src = readFileSync("components/city/Roads.tsx", "utf8");
    expect(src).toContain("deriveStreetNetwork");
    expect(src).toContain("routeAccent");
    // The blast-pulse machinery died with the import-edge ribbons.
    expect(src).not.toContain("BLAST_ROAD_WIDTH");
  });

  it("Districts pulls rendered blocks back so street tarmac clears them", () => {
    const src = readFileSync("components/city/Districts.tsx", "utf8");
    // The pull-back map from Task 1 drives the block box dims.
    expect(src).toContain("blockInsets");
    // The kerb ring reads the palette token instead of a hardcoded swatch.
    expect(src).toContain("kerbLight");
  });

  it("Legend and StatsBar speak street vocabulary", () => {
    const legend = readFileSync("components/city/Legend.tsx", "utf8");
    // Streets get their own swatch; the route accent is data encoding.
    expect(legend).toContain("routeAccent");
    expect(legend).toContain("asphalt");
    // The old hardcoded import-road swatch is retired.
    expect(legend).not.toContain("#77746F");
    // Two real-sized districts yield separator + ring corridors.
    const wide = makeLayout({
      buildings: [
        { fileId: "a.ts", x: -10, z: 0, w: 6, d: 6, h: 10 },
        { fileId: "b.ts", x: 10, z: 0, w: 6, d: 6, h: 20 },
      ],
      districts: [
        { path: "lib", x: -10, z: 0, w: 8, d: 8, depth: 0, label: "lib" },
        { path: "app", x: 10, z: 0, w: 8, d: 8, depth: 0, label: "app" },
      ],
    });
    expect(computeCityStats(wide).streets).toBeGreaterThan(0);
  });
});
