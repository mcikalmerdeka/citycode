"use client";

/**
 * ViewControls — the top-right chrome: a single compact row of pills.
 *
 * - "Reset view" fires the store's camera-reset nonce (requestResetView).
 * - Day-phase selector (morning/noon/sunset/night) → setTimeOfDay.
 * - Weather selector (clear/cloudy/rain) → setWeather.
 *
 * The option lists come from lib/city/theme (DAY_PHASES / WEATHERS) so the
 * UI can never drift from the values the scene understands.
 */

import { DAY_PHASES, WEATHERS, type DayPhase, type Weather } from "@/lib/city/theme";
import { useCityStore } from "@/lib/store";

const PHASE_LABELS: Record<DayPhase, string> = {
  morning: "Morning",
  noon: "Noon",
  sunset: "Sunset",
  night: "Night",
};

const WEATHER_LABELS: Record<Weather, string> = {
  clear: "Clear",
  cloudy: "Cloudy",
  rain: "Rain",
};

/** A segmented group of small pills sharing one aria group. */
function SegmentedGroup({
  label,
  options,
  current,
  onSelect,
  renderLabel,
}: {
  label: string;
  options: readonly string[];
  current: string;
  onSelect: (value: never) => void;
  renderLabel: (value: string) => string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {options.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={current === value}
          title={renderLabel(value)}
          onClick={() => onSelect(value as never)}
          className="pill-button focus-ring px-2.5 py-1 text-xs"
        >
          {renderLabel(value)}
        </button>
      ))}
    </div>
  );
}

export function ViewControls() {
  const timeOfDay = useCityStore((state) => state.timeOfDay);
  const setTimeOfDay = useCityStore((state) => state.setTimeOfDay);
  const weather = useCityStore((state) => state.weather);
  const setWeather = useCityStore((state) => state.setWeather);
  const requestResetView = useCityStore((state) => state.requestResetView);

  return (
    <div className="pill flex items-center gap-1 p-1">
      <button
        type="button"
        onClick={requestResetView}
        className="pill-button focus-ring px-2.5 py-1 text-xs"
      >
        Reset view
      </button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border)]" />
      <SegmentedGroup
        label="Time of day"
        options={DAY_PHASES}
        current={timeOfDay}
        onSelect={setTimeOfDay as (value: never) => void}
        renderLabel={(value) => PHASE_LABELS[value as DayPhase]}
      />
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[var(--border)]" />
      <SegmentedGroup
        label="Weather"
        options={WEATHERS}
        current={weather}
        onSelect={setWeather as (value: never) => void}
        renderLabel={(value) => WEATHER_LABELS[value as Weather]}
      />
    </div>
  );
}