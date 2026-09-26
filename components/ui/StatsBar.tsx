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

export interface CityStats {
  files: number;
  districts: number;
  roads: number;
}

/** Pure count derivation from a layout — no React, no DOM. */
export function computeCityStats(layout: CityLayout): CityStats {
  return {
    files: layout.buildings.length,
    districts: layout.districts.length,
    roads: layout.roads.length,
  };
}

/** One stat pill: bold value + gray label. */
function StatPill({ value, label }: { value: number; label: string }) {
  return (
    <span className="stat-pill">
      <span className="stat-value">{value}</span>
      <span>{label}</span>
    </span>
  );
}

export function StatsBar({ layout }: { layout: CityLayout }) {
  const stats = computeCityStats(layout);

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="City statistics">
      <StatPill value={stats.files} label="files" />
      <StatPill value={stats.districts} label="districts" />
      <StatPill value={stats.roads} label="roads" />
    </div>
  );
}