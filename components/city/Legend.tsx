/**
 * Legend — a DOM overlay pinned top-left of the scene area, always visible
 * (it never toggles with showLabels). Pure presentational: no hooks, no
 * handlers, pointer-events disabled so it can never steal an orbit click.
 *
 * Swatches reuse the exact scene palette so the key is pixel-honest, and the
 * closing line states the one rule the whole static view obeys: color is
 * reserved for compare mode.
 */

const SWATCH_BOX = "flex h-4 w-4 shrink-0 items-center justify-center";

export function Legend() {
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 w-max rounded-lg border border-zinc-800/80 bg-zinc-950/80 px-3 py-2.5 backdrop-blur-sm">
      <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
        City key
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
      </ul>
      <p className="mt-2.5 border-t border-zinc-800/80 pt-2 text-[10px] leading-snug text-zinc-500">
        color is reserved for compare mode
      </p>
    </div>
  );
}
