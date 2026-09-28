"use client";

/**
 * ViewControls — the stage's top-right chrome: two compact pills.
 *
 * - "Reset view" fires the store's camera-reset nonce (requestResetView).
 * - "World settings" opens a small popover holding the day-phase selector
 *   (setTimeOfDay), the weather selector (setWeather) and the district
 *   labels toggle. The popover content is always rendered and toggled with
 *   the `hidden` attribute, so the controls exist in the markup even closed.
 *
 * The option lists come from lib/city/theme (DAY_PHASES / WEATHERS) so the
 * UI can never drift from the values the scene understands.
 */

import { useEffect, useRef, useState } from "react";

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

/** A labelled segmented control: equal-width options in a soft track. */
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
    <div>
      <p className="eyebrow mb-1.5">{label}</p>
      <div role="group" aria-label={label} className="flex gap-0.5 rounded-lg bg-[var(--paper)] p-0.5">
        {options.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={current === value}
            onClick={() => onSelect(value as never)}
            className="focus-ring flex-1 rounded-md px-2 py-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink)] aria-pressed:bg-[var(--surface)] aria-pressed:font-medium aria-pressed:text-[var(--ink)] aria-pressed:shadow-[var(--pill-shadow)]"
          >
            {renderLabel(value)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ViewControls() {
  const timeOfDay = useCityStore((state) => state.timeOfDay);
  const setTimeOfDay = useCityStore((state) => state.setTimeOfDay);
  const weather = useCityStore((state) => state.weather);
  const setWeather = useCityStore((state) => state.setWeather);
  const showLabels = useCityStore((state) => state.showLabels);
  const toggleLabels = useCityStore((state) => state.toggleLabels);
  const requestResetView = useCityStore((state) => state.requestResetView);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — a popover, not a modal.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={requestResetView}
        className="pill-button focus-ring inline-flex items-center gap-1.5 text-xs"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <circle cx="8" cy="8" r="4.5" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
          <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
        </svg>
        Reset view
      </button>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="pill-button focus-ring inline-flex items-center gap-1.5 text-xs"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M2 4h7M13 4h1M2 8h2M8 8h6M2 12h8M14 12h0" />
          <circle cx="11" cy="4" r="1.6" />
          <circle cx="6" cy="8" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
        </svg>
        World settings
      </button>

      <div
        role="dialog"
        aria-label="World settings"
        hidden={!open}
        className="panel absolute right-0 top-full z-30 mt-2 w-72 space-y-3.5 p-3.5"
      >
        <SegmentedGroup
          label="Time of day"
          options={DAY_PHASES}
          current={timeOfDay}
          onSelect={setTimeOfDay as (value: never) => void}
          renderLabel={(value) => PHASE_LABELS[value as DayPhase]}
        />
        <SegmentedGroup
          label="Weather"
          options={WEATHERS}
          current={weather}
          onSelect={setWeather as (value: never) => void}
          renderLabel={(value) => WEATHER_LABELS[value as Weather]}
        />
        <label className="flex cursor-pointer items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-xs text-[var(--ink)]">
          District labels
          <input
            type="checkbox"
            checked={showLabels}
            onChange={toggleLabels}
            className="focus-ring h-4 w-4 accent-[var(--accent)]"
          />
        </label>
      </div>
    </div>
  );
}
