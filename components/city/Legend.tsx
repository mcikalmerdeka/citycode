/**
 * Legend — a DOM overlay pinned top-left of the scene area, always visible
 * (it never toggles with showLabels). Pure presentational: no handlers, no
 * pointer events, so it can never steal an orbit click.
 *
 * Swatches reuse the exact scene palette so the key is pixel-honest. In
 * compare modes (Phase 4) the closing "color is reserved" note is replaced
 * by the actual compare color rows.
 */

import { useCityStore } from "@/lib/store";

const SWATCH_BOX = "flex h-4 w-4 shrink-0 items-center justify-center";

/** Compare rows — hex values MUST match STATUS_COLORS in Buildings.tsx. */
const COMPARE_ROWS: Array<{ swatch: string; label: string }> = [
  { swatch: "h-4 w-1.5 rounded-[1px] bg-[#f59e0b]", label: "construction site · modified" },
  { swatch: "h-4 w-1.5 rounded-[1px] bg-[#a3e635]", label: "fresh construction · added" },
  { swatch: "h-0.5 w-4 rounded-[1px] bg-[#e2e8f0]", label: "foundation · untracked (about to commit)" },
  { swatch: "h-1.5 w-4 rounded-[1px] bg-[#57534e]", label: "rubble · deleted" },
  { swatch: "h-[2px] w-4 rounded-full bg-[#22d3ee]", label: "moved · renamed" },
  { swatch: "h-4 w-1.5 rounded-[1px] bg-[#ef4444]", label: "blast radius · importer touched" },
];

export function Legend() {
  const compareMode = useCityStore((state) => state.compareMode);
  const comparing = compareMode !== "static";

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 w-max rounded-lg border border-zinc-800/80 bg-zinc-950/80 px-3 py-2.5 backdrop-blur-sm">
      <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
        {comparing ? "Compare key" : "City key"}
      </p>
      <ul className="mt-2 space-y-2">
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-4 w-1.5 rounded-[1px] bg-[#8b8d98]" />
          </span>
          <span className="text-[11px] leading-none text-zinc-400">
            height · lines of code
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-1.5 w-4 rounded-[1px] bg-[#8b8d98]" />
          </span>
          <span className="text-[11px] leading-none text-zinc-400">
            footprint · function count
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-2 w-4 rounded-[1px] border border-[#3f424c] bg-[#2a2c33]" />
          </span>
          <span className="text-[11px] leading-none text-zinc-400">
            block · folder
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-[2px] w-4 rounded-full bg-[#5a5d66]" />
          </span>
          <span className="text-[11px] leading-none text-zinc-400">
            line · import road
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-3 w-1.5 rounded-[1px] bg-[#8b8d98] shadow-[0_0_6px_rgba(228,163,60,0.75)] ring-1 ring-[#e4a33c]" />
          </span>
          <span className="text-[11px] leading-none text-zinc-400">
            highlight · selected building
          </span>
        </li>
        {comparing &&
          COMPARE_ROWS.map((row) => (
            <li key={row.label} className="flex items-center gap-2.5">
              <span className={SWATCH_BOX} aria-hidden="true">
                <span className={row.swatch} />
              </span>
              <span className="text-[11px] leading-none text-zinc-400">{row.label}</span>
            </li>
          ))}
      </ul>
      {!comparing && (
        <p className="mt-2.5 border-t border-zinc-800/80 pt-2 text-[10px] leading-snug text-zinc-500">
          color is reserved for compare mode
        </p>
      )}
    </div>
  );
}
