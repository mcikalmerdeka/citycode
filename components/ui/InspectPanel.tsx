"use client";

/**
 * InspectPanel — details for the selected building's file, derived purely
 * from the graph (useMemo; no extra state). Importer/importee rows are
 * buttons that re-select, so the panel doubles as a keyboard-friendly way to
 * walk the import graph. No LLM summaries here — those arrive in Phase 3.
 */

import { useMemo } from "react";

import type { CodeGraph, ImportEdge, SymbolDef } from "@/lib/types";
import { useCityStore } from "@/lib/store";
import { ExplainPanel } from "./ExplainPanel";

/** A file linked to the selection by one or more import edges. */
interface LinkedFile {
  id: string;
  /** Edge count for this pair — rendered as ×N when > 1 (multiple symbols). */
  edgeCount: number;
}

interface Selection {
  path: string;
  loc: number;
  language: string;
  functions: SymbolDef[];
  importers: LinkedFile[];
  importees: LinkedFile[];
}

/**
 * Group edges touching `fileId` by the file on the other end.
 * "importers" → edges with toId === fileId, grouped by fromId;
 * "importees" → edges with fromId === fileId, grouped by toId.
 */
function linkedFiles(
  edges: ImportEdge[],
  direction: "importers" | "importees",
  fileId: string,
): LinkedFile[] {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const other =
      direction === "importers"
        ? edge.toId === fileId
          ? edge.fromId
          : null
        : edge.fromId === fileId
          ? edge.toId
          : null;
    if (other === null) continue;
    counts.set(other, (counts.get(other) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, edgeCount]) => ({ id, edgeCount }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function FileLinkList({
  title,
  files,
  onSelect,
}: {
  title: string;
  files: LinkedFile[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="mt-4">
      <h3 className="eyebrow">
        {title} ({files.length})
      </h3>
      {files.length === 0 ? (
        <p className="mt-1.5 px-1.5 text-[11px] text-[var(--ink-secondary)]">none</p>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {files.map((file) => (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => onSelect(file.id)}
                className="focus-ring flex w-full items-baseline justify-between gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--paper)]"
              >
                <span className="min-w-0 truncate font-mono text-xs text-[var(--ink)]">
                  {file.id}
                </span>
                {file.edgeCount > 1 ? (
                  <span className="shrink-0 font-mono text-[10px] text-[var(--ink-secondary)]">
                    ×{file.edgeCount}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function InspectPanel({
  graph,
  repoKey,
}: {
  graph: CodeGraph | null;
  repoKey: string | null;
}) {
  const selectedId = useCityStore((state) => state.selectedId);
  const select = useCityStore((state) => state.select);
  const requestFocus = useCityStore((state) => state.requestFocus);

  const selection = useMemo<Selection | null>(() => {
    if (graph === null || selectedId === null) return null;
    const file = graph.files.find((candidate) => candidate.id === selectedId);
    if (file === undefined) return null;
    return {
      path: file.path,
      loc: file.loc,
      language: file.language,
      functions: file.functions,
      importers: linkedFiles(graph.edges, "importers", selectedId),
      importees: linkedFiles(graph.edges, "importees", selectedId),
    };
  }, [graph, selectedId]);

  if (selection === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-center text-xs leading-relaxed text-[var(--ink-secondary)]">
          Click a building to inspect a file
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-xs leading-relaxed text-[var(--ink)]">
          {selection.path}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (selectedId !== null) requestFocus(selectedId);
            }}
            aria-label="Center view on this building"
            title="Center view on this building"
            className="focus-ring rounded-full p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="3.2" />
              <path d="M6 0.8v2M6 9.2v2M0.8 6h2M9.2 6h2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => select(null)}
            aria-label="Clear selection"
            className="focus-ring rounded-full p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
          </button>
        </div>
      </div>

      <div className="mt-3 flex gap-5">
        <div>
          <p className="font-mono text-lg leading-none text-[var(--ink)]">{selection.loc}</p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--ink-secondary)]">loc</p>
        </div>
        <div>
          <p className="font-mono text-lg leading-none text-[var(--ink)]">
            {selection.functions.length}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--ink-secondary)]">functions</p>
        </div>
        <div>
          <p className="font-mono text-lg leading-none text-[var(--ink)]">{selection.language}</p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--ink-secondary)]">language</p>
        </div>
      </div>

      {selection.functions.length > 0 && (
        <section className="mt-4">
          <h3 className="eyebrow">
            Functions ({selection.functions.length})
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {selection.functions.map((fn) => (
              <li
                key={`${fn.name}:${fn.startLine}`}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate font-mono text-xs text-[var(--ink)]">
                  {fn.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--ink-secondary)]">
                  L{fn.startLine}–{fn.endLine}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {repoKey !== null && selectedId !== null && (
        <ExplainPanel repoKey={repoKey} fileId={selectedId} />
      )}

      <FileLinkList
        title="Imported by"
        files={selection.importers}
        onSelect={select}
      />
      <FileLinkList
        title="Imports"
        files={selection.importees}
        onSelect={select}
      />
    </div>
  );
}
