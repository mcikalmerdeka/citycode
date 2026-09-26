/**
 * Legend — a DOM overlay pinned top-left of the scene area, always visible
 * (it never toggles with showLabels). Pure presentational: no handlers, no
 * pointer events, so it can never steal an orbit click.
 *
 * Restyled to the Small World pill chrome: a white rounded panel using the
 * Wave-0 tokens. Compare swatch colors come from
 * `components/city/compareAccent.ts` via its documented contract:
 * `compareAccent(compareMode, status)` → `{ roofTint?, outline? }`.
 *
 * INTEGRATION NOTE (Wave 2.1): that module is being created concurrently by
 * another agent. This file is written against the documented contract above;
 * if the shipped module shape differs (e.g. different keys or return fields),
 * only the COMPARE_ROWS mapping below needs adjusting — the layout and
 * styling here are contract-independent.
 */

import { compareAccent } from "./compareAccent";
import { useCityStore } from "@/lib/store";
import type { CompareMode } from "@/lib/store";

const SWATCH_BOX = "flex h-4 w-4 shrink-0 items-center justify-center";

/** Compare rows — colors resolved through compareAccent(compareMode, status). */
const COMPARE_ROWS: Array<{ status: string; label: string }> = [
  { status: "construction", label: "construction site · modified" },
  { status: "fresh", label: "fresh construction · added" },
  { status: "foundation", label: "foundation · untracked (about to commit)" },
  { status: "rubble", label: "rubble · deleted" },
  { status: "moved", label: "moved · renamed" },
  { status: "blast", label: "blast radius · importer touched" },
];

/** Resolve a swatch color defensively against the compareAccent contract. */
function accentColor(compareMode: CompareMode, status: string): string {
  const accent = compareAccent(compareMode, status) as {
    roofTint?: string;
    outline?: string;
  } | null | undefined;
  return accent?.roofTint ?? accent?.outline ?? "#8E8474";
}

export function Legend() {
  const compareMode = useCityStore((state) => state.compareMode);
  const comparing = compareMode !== "static";

  return (
    <div className="panel pointer-events-none absolute left-3 top-3 z-20 w-max rounded-2xl px-3.5 py-3">
      <p className="eyebrow">
        {comparing ? "Compare key" : "City key"}
      </p>
      <ul className="mt-2 space-y-2">
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-4 w-1.5 rounded-[1px] bg-[#B8AFA2]" />
          </span>
          <span className="text-[11px] leading-none text-[var(--ink-secondary)]">
            height · lines of code
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-1.5 w-4 rounded-[1px] bg-[#B8AFA2]" />
          </span>
          <span className="text-[11px] leading-none text-[var(--ink-secondary)]">
            footprint · function count
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-2 w-4 rounded-[1px] border border-[var(--border)] bg-[#D0D3C3]" />
          </span>
          <span className="text-[11px] leading-none text-[var(--ink-secondary)]">
            block · folder
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-[2px] w-4 rounded-full bg-[#77746F]" />
          </span>
          <span className="text-[11px] leading-none text-[var(--ink-secondary)]">
            line · import road
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span className={SWATCH_BOX} aria-hidden="true">
            <span className="h-3 w-1.5 rounded-[1px] bg-[#D9D3C9] shadow-[0_0_6px_rgba(217,164,65,0.75)] ring-1 ring-[#D9A441]" />
          </span>
          <span className="text-[11px] leading-none text-[var(--ink-secondary)]">
            highlight · selected building
          </span>
        </li>
        {comparing &&
          COMPARE_ROWS.map((row) => (
            <li key={row.label} className="flex items-center gap-2.5">
              <span className={SWATCH_BOX} aria-hidden="true">
                <span
                  className="h-3 w-3 rounded-[3px] border border-[var(--border)]"
                  style={{ background: accentColor(compareMode, row.status) }}
                />
              </span>
              <span className="text-[11px] leading-none text-[var(--ink-secondary)]">{row.label}</span>
            </li>
          ))}
      </ul>
      {!comparing && (
        <p className="mt-2.5 border-t border-[var(--border)] pt-2 text-[10px] leading-snug text-[var(--ink-secondary)]">
          color is reserved for compare mode
        </p>
      )}
    </div>
  );
}