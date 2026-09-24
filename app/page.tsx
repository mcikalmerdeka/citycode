"use client";

/**
 * CityCode home — a two-pane app shell: the import/inspect column on the
 * left, the 3D city (or the metaphor explainer) on the right.
 *
 * The scene is loaded via next/dynamic with ssr:false (WebGL is
 * client-only), which is legal here because this module is a client
 * component. A fresh analysis result always clears the selection so the
 * inspect panel can never show a file from a previous city.
 */

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

import { Legend } from "@/components/city/Legend";
import { CompareBar } from "@/components/ui/CompareBar";
import { FileTree } from "@/components/ui/FileTree";
import { ImportForm, type AnalyzeResponse } from "@/components/ui/ImportForm";
import { InspectPanel } from "@/components/ui/InspectPanel";
import { useCityStore } from "@/lib/store";

const CityScene = dynamic(
  () => import("@/components/city/CityScene").then((mod) => mod.CityScene),
  { ssr: false },
);

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 px-8 text-center">
      {/* Mini skyline on a district block — the metaphor, in miniature */}
      <div aria-hidden="true" className="flex flex-col items-center">
        <div className="flex items-end gap-1.5">
          <span className="h-6 w-3 rounded-[1px] bg-[#8b8d98]/60" />
          <span className="h-10 w-4 rounded-[1px] bg-[#8b8d98]" />
          <span className="h-4 w-2.5 rounded-[1px] bg-[#8b8d98]/40" />
          <span className="h-14 w-5 rounded-[1px] bg-[#8b8d98]" />
          <span className="h-8 w-3 rounded-[1px] bg-[#8b8d98]/70" />
          <span className="h-5 w-2 rounded-[1px] bg-[#8b8d98]/50" />
        </div>
        <div className="mt-1 h-1.5 w-[130%] rounded-[1px] border border-[#3f424c] bg-[#2a2c33]" />
      </div>
      <div className="max-w-sm space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-zinc-100">
          See your codebase as a city
        </h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Every file becomes a building — its height is lines of code, its
          footprint the number of functions. Folders frame their files as city
          blocks, and imports run between buildings as roads.
        </p>
        <p className="text-xs leading-relaxed text-zinc-600">
          Enter a local folder path on the left to build your first city.
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const select = useCityStore((state) => state.select);
  const showLabels = useCityStore((state) => state.showLabels);
  const toggleLabels = useCityStore((state) => state.toggleLabels);
  const compareMode = useCityStore((state) => state.compareMode);

  const handleSuccess = useCallback(
    (data: AnalyzeResponse) => {
      setResult(data);
      select(null);
    },
    [select],
  );

  const handleCompareResult = useCallback((data: AnalyzeResponse) => handleSuccess(data), [handleSuccess]);

  return (
    <div className="flex h-dvh overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-900/30">
        <div className="border-b border-zinc-800/70 p-4">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.3em] text-zinc-200">
              CityCode
            </p>
            <span className="rounded border border-zinc-700/70 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-zinc-500">
              {compareMode === "static" ? "static" : compareMode === "prev" ? "prev (HEAD vs. HEAD~1)" : "workdir"}
              {result?.fromCache ? " · snapshot" : ""}
              {result?.skim ? " · summarized" : ""}
            </span>
          </div>
          <ImportForm onSuccess={handleSuccess} />
          {result && result.warnings.length > 0 && (
            <div className="mt-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                Warnings ({result.warnings.length})
              </p>
              <ul className="mt-1.5 max-h-36 space-y-1 overflow-y-auto pr-1">
                {result.warnings.map((warning) => (
                  <li
                    key={`${warning.path}:${warning.message}`}
                    className="text-[11px] leading-snug text-zinc-500"
                  >
                    <span className="font-mono text-zinc-400">{warning.path}</span>{" "}
                    — {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <InspectPanel graph={result?.graph ?? null} repoKey={result?.repoKey ?? null} />
        </div>
      </aside>

      <main className="relative min-w-0 flex-1">
        {result ? (
          <>
            <CityScene
              layout={result.layout}
              changeSet={compareMode === "static" ? null : (result.changeSet ?? null)}
            />
            <Legend />
            <CompareBar
              repoKey={result.repoKey}
              isGitRepo={result.graph.headSha !== undefined}
              onCompareResult={handleCompareResult}
            />
            <button
              type="button"
              onClick={toggleLabels}
              aria-pressed={showLabels}
              className="absolute right-3 top-3 z-20 rounded-md border border-zinc-700/80 bg-zinc-900/80 px-2.5 py-1 text-[11px] font-medium text-zinc-400 backdrop-blur transition-colors hover:text-zinc-200 aria-pressed:border-zinc-100 aria-pressed:bg-zinc-100 aria-pressed:text-zinc-950"
            >
              Labels
            </button>
          </>
        ) : (
          <EmptyState />
        )}
      </main>

      {/*
       * Right sidebar — the IDE-style working directory for the analyzed
       * repo. Clicking a file selects its building in the city and flies the
       * camera there; selection consumers react through the same store.
       */}
      {result && (
        <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800/70 bg-zinc-900/30">
          <FileTree
            graph={result.graph}
            changeSet={compareMode === "static" ? null : (result.changeSet ?? null)}
          />
        </aside>
      )}
    </div>
  );
}
