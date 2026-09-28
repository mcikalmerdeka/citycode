"use client";

/**
 * StatsBar — the stats pill cluster (top-left chrome): live counts derived
 * from the city layout, rendered as white pills with a bold number and a
 * gray label, matching the Small World reference styling.
 *
 * The counting logic is exported as pure helpers so it can be unit-tested
 * without a DOM (the vitest suite runs in a node environment).
 */

import type { CityLayout } from "@/lib/city/layout";
import { deriveStreetNetwork } from "@/lib/city/streets";

export interface CityStats {
  files: number;
  districts: number;
  /** Import edges — the code's dependency lines, never drivable. */
  roads: number;
  /** Street corridors the tarmac is drawn on. */
  streets: number;
}

/** Pure count derivation from a layout — no React, no DOM. */
export function computeCityStats(layout: CityLayout): CityStats {
  return {
    files: layout.buildings.length,
    districts: layout.districts.length,
    roads: layout.roads.length,
    streets: deriveStreetNetwork(layout).corridors.length,
  };
}

/** One stat inside a grouped pill: bold value + gray label. */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="stat-item">
      <span className="stat-value">{value}</span>
      <span>{label}</span>
    </span>
  );
}

export function StatsBar({ layout }: { layout: CityLayout }) {
  const stats = computeCityStats(layout);

  return (
    <div className="stat-pill" aria-label="City statistics">
      <Stat value={stats.files} label="files" />
      <Stat value={stats.districts} label="districts" />
      <Stat value={stats.streets} label="streets" />
      <Stat value={stats.roads} label="imports" />
    </div>
  );
}