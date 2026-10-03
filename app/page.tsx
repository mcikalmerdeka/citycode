"use client";

/**
 * CityCode home — the Small World composition: a slim page header over a
 * rounded cream "stage" card that holds the full-bleed 3D city and all of
 * its floating chrome.
 *
 * Layout:
 * - header:        title + tagline (left), Repo Guidance (right)
 * - stage top-left:   stats pill
 * - stage top-right:  Reset view + World settings popover (time, weather, labels)
 * - stage left edge:  collapsible Import panel (ImportForm + warnings)
 * - stage right edge: collapsible FileTree drawer (with file search)
 * - stage bottom-left:   collapsible City key
 * - stage bottom-center: compare mode tabs (+ summary) and quick-jump chips
 *
 * Each action lives in exactly one place — no duplicate buttons.
 * - stage center:        compact inspector card when a building is selected
 *
 * The scene is loaded via next/dynamic with ssr:false (WebGL is
 * client-only). A fresh analysis result always clears the selection so the
 * inspect panel can never show a file from a previous city.
 */

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";

import { Legend } from "@/components/city/Legend";
import { CompareBar } from "@/components/ui/CompareBar";
import { FileTree } from "@/components/ui/FileTree";
import { ImportForm, type AnalyzeResponse } from "@/components/ui/ImportForm";
import { InspectPanel } from "@/components/ui/InspectPanel";
import { DemoPlayer } from "@/components/ui/DemoPlayer";
import { GuidanceModal } from "@/components/ui/GuidanceModal";
import { StatsBar } from "@/components/ui/StatsBar";
import { ViewControls } from "@/components/ui/ViewControls";
import { useFlowStore } from "@/lib/guidance/flowStore";
import { useCityStore } from "@/lib/store";

const CityScene = dynamic(
  () => import("@/components/city/CityScene").then((mod) => mod.CityScene),
  { ssr: false },
);

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="pointer-events-none flex h-full flex-col items-center justify-center gap-8 px-8 text-center">
      {/* A tiny storybook block — the metaphor, in miniature. */}
      <div aria-hidden="true" className="flex flex-col items-center">
        <div className="flex items-end gap-1.5">
          <House wall="#EDE3CF" roof="#C24A31" h={28} w={22} />
          <House wall="#B6523B" roof="#4A4E56" h={40} w={26} />
          <span className="h-9 w-3.5 rounded-full bg-[#E0892F]" />
          <House wall="#D9DBDA" roof="#8F9296" h={58} w={24} flat />
          <House wall="#E9D9B4" roof="#5E8F53" h={32} w={24} />
          <span className="h-7 w-3 rounded-full bg-[#E7AE3C]" />
        </div>
        <div className="h-2 w-64 rounded-[2px] bg-[#D9D5CA]" />
        <div className="h-3 w-64 rounded-b-[3px] bg-[repeating-linear-gradient(180deg,#D8C29C_0_3px,#C4A87C_3px_4px)]" />
      </div>
      <div className="max-w-sm space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--ink)]">
          See your codebase as a little town
        </h2>
        <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">
          Every file becomes a building — its height is lines of code, its
          footprint the number of functions. Folders become city blocks, and
          imports run between buildings as routes.
        </p>
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)] opacity-70">
          Use the Import panel on the left to build your first town.
        </p>
      </div>
    </div>
  );
}

function House({ wall, roof, h, w, flat = false }: { wall: string; roof: string; h: number; w: number; flat?: boolean }) {
  return (
    <span className="flex flex-col items-center">
      {flat ? (
        <span className="h-1.5 rounded-[1px]" style={{ width: w + 2, background: roof }} />
      ) : (
        <span
          style={{
            width: 0,
            height: 0,
            borderLeft: `${w / 2 + 3}px solid transparent`,
            borderRight: `${w / 2 + 3}px solid transparent`,
            borderBottom: `${w * 0.55}px solid ${roof}`,
          }}
        />
      )}
      <span
        className="bg-[repeating-linear-gradient(90deg,transparent_0_4px,rgba(60,74,94,0.55)_4px_7px)] bg-[length:100%_40%] bg-center bg-no-repeat"
        style={{ width: w, height: h, backgroundColor: wall }}
      />
    </span>
  );
}

export default function Home() {
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const select = useCityStore((state) => state.select);
  const compareMode = useCityStore((state) => state.compareMode);
  const requestFocus = useCityStore((state) => state.requestFocus);
  const selectedId = useCityStore((state) => state.selectedId);
  const flowActive = useFlowStore((state) => state.flow !== null);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(false);

  const handleSuccess = useCallback(
    (data: AnalyzeResponse) => {
      setResult(data);
      select(null);
      // A demo belongs to the city it was traced in — never carry it over.
      useFlowStore.getState().stop();
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
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--paper)] font-sans text-[var(--ink)]">
      {/* ---- Page header ---- */}
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">CityCode</h1>
          <p className="text-[13px] text-[var(--ink-secondary)]">
            Your codebase as a living town. Change one file, watch everything react.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setGuidanceOpen(true)}
            aria-haspopup="dialog"
            disabled={!hasResult}
            className="ghost-button focus-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" />
              <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" />
              <circle cx="8" cy="11.6" r=".5" fill="currentColor" />
            </svg>
            Repo Guidance
          </button>
        </div>
      </header>

      {/* ---- Stage: the cream card holding the city + floating chrome ---- */}
      <div className="stage relative mx-4 mb-4 min-h-0 flex-1 overflow-hidden">
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

        {/* Top-left: stats */}
        {hasResult && (
          <div className="absolute left-3.5 top-3.5 z-20 max-w-[calc(100%-30rem)]">
            <StatsBar layout={result.layout} />
          </div>
        )}

        {/* Top-right: view controls */}
        <div className="absolute right-3.5 top-3.5 z-20">
          <ViewControls />
        </div>

        {/* Left edge: collapsible import panel */}
        <div className="absolute left-3.5 top-1/2 z-20 -translate-y-1/2">
          {importOpen ? (
            <section aria-label="Import a repository" className="panel max-h-[62vh] w-72 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="eyebrow">Import</p>
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  aria-label="Collapse import panel"
                  className="focus-ring rounded-md p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                >
                  <CloseIcon />
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
                        <span className="font-mono text-[var(--ink)]">{warning.path}</span> — {warning.message}
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

        {/* Right edge: FileTree drawer (steps aside while a demo shows its code) */}
        {hasResult && !flowActive && (
          <div className="absolute right-3.5 top-1/2 z-20 -translate-y-1/2">
            {treeOpen ? (
              <section aria-label="Working directory" className="panel flex max-h-[62vh] w-72 flex-col overflow-hidden">
                <FileTree
                  graph={result.graph}
                  changeSet={compareMode === "static" ? null : (result.changeSet ?? null)}
                  onClose={() => setTreeOpen(false)}
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
        {hasResult && selectedId !== null && !flowActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="panel pointer-events-auto max-h-[60vh] w-80 overflow-y-auto">
              <InspectPanel graph={result.graph} repoKey={result.repoKey} />
            </div>
          </div>
        )}

        {/* Guided demo: player (bottom-center) + code viewer (right) replace the dock */}
        {hasResult && flowActive && (
          <DemoPlayer onOpenGuide={() => setGuidanceOpen(true)} keysEnabled={!guidanceOpen} />
        )}

        {/* Bottom-center dock: compare mode tabs (+ summary) and quick jumps */}
        {hasResult && !flowActive && (
          <nav aria-label="Compare and quick actions" className="dock">
            <CompareBar
              repoKey={result.repoKey}
              isGitRepo={result.graph.headSha !== undefined}
              onCompareResult={handleCompareResult}
            />
            <div className="dock-chips">
              <button
                type="button"
                disabled={largestFileId === null}
                onClick={() => focusFile(largestFileId)}
                title={largestFileId ?? undefined}
                className="chip focus-ring"
              >
                Largest file
              </button>
              <button
                type="button"
                disabled={mostImportedFileId === null}
                onClick={() => focusFile(mostImportedFileId)}
                title={mostImportedFileId ?? undefined}
                className="chip focus-ring"
              >
                Most imported
              </button>
            </div>
          </nav>
        )}
      </div>

      {hasResult && (
        <GuidanceModal repoKey={result.repoKey} open={guidanceOpen} onClose={() => setGuidanceOpen(false)} />
      )}
    </div>
  );
}
