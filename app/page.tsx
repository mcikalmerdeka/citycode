"use client";

/**
 * CityCode home — the Small World composition: a full-bleed 3D city canvas
 * with floating white chrome over it.
 *
 * Layout (all chrome floats over the canvas, nothing is a fixed sidebar):
 * - top-left:    header (title + tagline) and the stats pill cluster
 * - top-right:   ViewControls (reset view / day phase / weather) + Labels
 *                and Repo Guidance pills
 * - top-center:  CompareBar (mode tabs + change summary)
 * - left edge:   collapsible Import panel (ImportForm + warnings)
 * - right edge:  collapsible FileTree drawer (slide-over)
 * - bottom-left: Legend
 * - bottom-center: dock of suggestion chips wired to real actions
 * - center:      compact inspector card when a building is selected
 *
 * The scene is loaded via next/dynamic with ssr:false (WebGL is
 * client-only), which is legal here because this module is a client
 * component. A fresh analysis result always clears the selection so the
 * inspect panel can never show a file from a previous city.
 */

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";

import { Legend } from "@/components/city/Legend";
import { CompareBar } from "@/components/ui/CompareBar";
import { FileTree } from "@/components/ui/FileTree";
import { ImportForm, type AnalyzeResponse } from "@/components/ui/ImportForm";
import { InspectPanel } from "@/components/ui/InspectPanel";
import { GuidanceModal } from "@/components/ui/GuidanceModal";
import { StatsBar } from "@/components/ui/StatsBar";
import { ViewControls } from "@/components/ui/ViewControls";
import { useCityStore } from "@/lib/store";

const CityScene = dynamic(
  () => import("@/components/city/CityScene").then((mod) => mod.CityScene),
  { ssr: false },
);

function EmptyState() {
  return (
    <div className="pointer-events-none flex h-full flex-col items-center justify-center gap-7 px-8 text-center">
      {/* Mini skyline on a district block — the metaphor, in miniature */}
      <div aria-hidden="true" className="flex flex-col items-center">
        <div className="flex items-end gap-1.5">
          <span className="h-6 w-3 rounded-[1px] bg-[#B8AFA2]/60" />
          <span className="h-10 w-4 rounded-[1px] bg-[#B8AFA2]" />
          <span className="h-4 w-2.5 rounded-[1px] bg-[#B8AFA2]/40" />
          <span className="h-14 w-5 rounded-[1px] bg-[#B8AFA2]" />
          <span className="h-8 w-3 rounded-[1px] bg-[#B8AFA2]/70" />
          <span className="h-5 w-2 rounded-[1px] bg-[#B8AFA2]/50" />
        </div>
        <div className="mt-1 h-1.5 w-[130%] rounded-[1px] border border-[var(--border)] bg-[#D0D3C3]" />
      </div>
      <div className="max-w-sm space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--ink)]">
          See your codebase as a city
        </h2>
        <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">
          Every file becomes a building — its height is lines of code, its
          footprint the number of functions. Folders frame their files as city
          blocks, and imports run between buildings as roads.
        </p>
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)] opacity-70">
          Use the Import panel on the left to build your first city.
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
  const setCompareMode = useCityStore((state) => state.setCompareMode);
  const requestFocus = useCityStore((state) => state.requestFocus);
  const selectedId = useCityStore((state) => state.selectedId);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(false);

  const handleSuccess = useCallback(
    (data: AnalyzeResponse) => {
      setResult(data);
      select(null);
      // A fresh city: collapse the import panel, open the tree drawer.
      setImportOpen(false);
      setTreeOpen(true);
    },
    [select],
  );

  const handleCompareResult = useCallback((data: AnalyzeResponse) => handleSuccess(data), [handleSuccess]);

  // Dock chip targets: the largest building (most LOC) and the most-imported
  // file (highest importer edge count), computed from the current result.
  const largestFileId = useMemo(() => {
    if (result === null) return null;
    let best: { id: string; h: number } | null = null;
    for (const building of result.layout.buildings) {
      if (best === null || building.h > best.h) best = { id: building.fileId, h: building.h };
    }
    return best?.id ?? null;
  }, [result]);

  const mostImportedFileId = useMemo(() => {
    if (result === null) return null;
    const counts = new Map<string, number>();
    for (const edge of result.graph.edges) {
      counts.set(edge.toId, (counts.get(edge.toId) ?? 0) + 1);
    }
    let best: { id: string; count: number } | null = null;
    for (const [id, count] of counts) {
      if (best === null || count > best.count) best = { id, count };
    }
    return best?.id ?? null;
  }, [result]);

  const focusFile = useCallback(
    (fileId: string | null) => {
      if (fileId === null) return;
      select(fileId);
      requestFocus(fileId);
    },
    [select, requestFocus],
  );

  const hasResult = result !== null;

  return (
    <div className="relative h-dvh overflow-hidden bg-[var(--paper)] font-sans text-[var(--ink)]">
      {/* Full-bleed 3D canvas */}
      <main className="absolute inset-0">
        {hasResult ? (
          <CityScene
            layout={result.layout}
            changeSet={compareMode === "static" ? null : (result.changeSet ?? null)}
          />
        ) : (
          <EmptyState />
        )}
      </main>

      {/* ---- Floating chrome ---- */}

      {/* Top-left: header + stats */}
      <header className="absolute left-4 top-4 z-20 flex max-w-[calc(100%-24rem)] flex-col gap-2.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-base font-bold tracking-tight text-[var(--ink)]">CityCode</h1>
          <p className="text-xs text-[var(--ink-secondary)]">Your codebase as a living city.</p>
        </div>
        {hasResult && <StatsBar layout={result.layout} />}
      </header>

      {/* Top-right: view controls + labels/guidance */}
      <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
        <ViewControls />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleLabels}
            aria-pressed={showLabels}
            className="pill-button focus-ring text-xs"
          >
            Labels
          </button>
          <button
            type="button"
            onClick={() => setGuidanceOpen(true)}
            aria-haspopup="dialog"
            className="pill-button focus-ring text-xs"
          >
            Repo Guidance
          </button>
        </div>
      </div>

      {/* Top-center: compare tabs + summary */}
      {hasResult && (
        <CompareBar
          repoKey={result.repoKey}
          isGitRepo={result.graph.headSha !== undefined}
          onCompareResult={handleCompareResult}
        />
      )}

      {/* Left edge: collapsible import panel */}
      <div className="absolute left-4 top-1/2 z-20 -translate-y-1/2">
        {importOpen ? (
          <section
            aria-label="Import a repository"
            className="panel w-72 max-h-[70vh] overflow-y-auto p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="eyebrow">Import</p>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                aria-label="Collapse import panel"
                className="focus-ring rounded-full p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
              >
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M2 2l8 8M10 2l-8 8" />
                </svg>
              </button>
            </div>
            <ImportForm onSuccess={handleSuccess} />
            {hasResult && result.warnings.length > 0 && (
              <div className="mt-4">
                <p className="eyebrow">Warnings ({result.warnings.length})</p>
                <ul className="mt-1.5 max-h-36 space-y-1 overflow-y-auto pr-1">
                  {result.warnings.map((warning) => (
                    <li
                      key={`${warning.path}:${warning.message}`}
                      className="text-[11px] leading-snug text-[var(--ink-secondary)]"
                    >
                      <span className="font-mono text-[var(--ink)]">{warning.path}</span>{" "}
                      — {warning.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ) : (
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            aria-expanded={false}
            aria-label="Open import panel"
            className="pill-button focus-ring text-xs"
          >
            Import
          </button>
        )}
      </div>

      {/* Right edge: FileTree slide-over drawer */}
      {hasResult && (
        <div className="absolute right-4 top-1/2 z-20 -translate-y-1/2">
          {treeOpen ? (
            <section
              aria-label="Working directory"
              className="panel flex max-h-[70vh] w-72 flex-col overflow-hidden"
            >
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
                <p className="eyebrow">Workspace</p>
                <button
                  type="button"
                  onClick={() => setTreeOpen(false)}
                  aria-label="Collapse file tree"
                  className="focus-ring rounded-full p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                >
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              </div>
              <FileTree
                graph={result.graph}
                changeSet={compareMode === "static" ? null : (result.changeSet ?? null)}
              />
            </section>
          ) : (
            <button
              type="button"
              onClick={() => setTreeOpen(true)}
              aria-expanded={false}
              aria-label="Open file tree"
              className="pill-button focus-ring text-xs"
            >
              Files
            </button>
          )}
        </div>
      )}

      {/* Bottom-left: legend */}
      {hasResult && <Legend />}

      {/* Center: compact inspector card for the selected building */}
      {hasResult && selectedId !== null && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="panel pointer-events-auto max-h-[60vh] w-80 overflow-y-auto rounded-2xl">
            <InspectPanel graph={result.graph} repoKey={result.repoKey} />
          </div>
        </div>
      )}

      {/* Bottom-center: suggestion chips wired to real actions */}
      <nav aria-label="Quick actions" className="dock">
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="chip focus-ring"
        >
          Import a repo
        </button>
        <button
          type="button"
          disabled={largestFileId === null}
          onClick={() => focusFile(largestFileId)}
          title={largestFileId ?? "Import a repo first"}
          className="chip focus-ring"
        >
          Largest files
        </button>
        <button
          type="button"
          disabled={mostImportedFileId === null}
          onClick={() => focusFile(mostImportedFileId)}
          title={mostImportedFileId ?? "Import a repo first"}
          className="chip focus-ring"
        >
          Most imported
        </button>
        <button
          type="button"
          disabled={!hasResult || result.graph.headSha === undefined}
          onClick={() => setCompareMode(compareMode === "prev" ? "static" : "prev")}
          aria-pressed={compareMode === "prev"}
          title="Compare against the previous commit"
          className="chip focus-ring"
        >
          Previous commit
        </button>
      </nav>

      {hasResult && (
        <GuidanceModal repoKey={result.repoKey} open={guidanceOpen} onClose={() => setGuidanceOpen(false)} />
      )}
    </div>
  );
}