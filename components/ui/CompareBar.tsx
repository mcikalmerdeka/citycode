"use client";

/**
 * CompareBar — the Phase 4 UI: a mode switch glued to the app's top-center
 * plus the one-commit change summary panel.
 *
 * Zero layout shift lives here by construction: switching to "prev" POSTs
 * /api/analyze with the CURRENT repoKey and mode "prev", which the server
 * answers from the stored analysis — the identical layout JSON the static
 * view already rendered. Nothing here re-runs the import form.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import type { AnalyzeResponse } from "./ImportForm";
import type { ChangeSet } from "@/lib/diff/apply";
import { useCityStore, type CompareMode } from "@/lib/store";

const MODES: Array<[CompareMode, string, string]> = [
  ["static", "Static", "as the code sits now"],
  ["prev", "Previous commit", "HEAD vs. HEAD~1"],
  // Phase 5 lands the workdir compare; the button is visibly disabled with
  // the reason instead of silently missing (PRD: honest degradation).
  ["workdir", "About to commit", "HEAD vs. working directory — arrives with the next phase"],
];

async function fetchSummary(
  repoKey: string,
): Promise<{ summary: string; cached: boolean }> {
  const response = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    response.ok &&
    typeof body === "object" &&
    body !== null &&
    typeof (body as { summary?: unknown }).summary === "string"
  ) {
    return body as { summary: string; cached: boolean };
  }
  if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
    throw new Error((body as { error: string }).error);
  }
  throw new Error(`Change summary failed (${response.status})`);
}

export function CompareBar({
  repoKey,
  onCompareResult,
}: {
  repoKey: string;
  onCompareResult: (data: AnalyzeResponse) => void;
}) {
  const compareMode = useCityStore((state) => state.compareMode);
  const setCompareMode = useCityStore((state) => state.setCompareMode);

  const changeQuery = useQuery({
    queryKey: ["compare-analysis", repoKey],
    queryFn: async (): Promise<AnalyzeResponse> => {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "local", mode: "prev", repoKey }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && typeof body === "object" && body !== null && typeof (body as { graph?: unknown }).graph === "object") {
        return body as AnalyzeResponse;
      }
      if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
        throw new Error((body as { error: string }).error);
      }
      throw new Error(`Compare request failed (${response.status})`);
    },
    enabled: compareMode === "prev",
    staleTime: Infinity,
    retry: false,
  });

  // Hand the validated compare result up once per change-set so the scene
  // re-renders from the same { graph, layout } pair (an effect, not a
  // render-phase call — the parent sets state).
  useEffect(() => {
    if (changeQuery.data !== undefined && changeQuery.data.changeSet !== undefined) {
      onCompareResult(changeQuery.data);
    }
  }, [changeQuery.data, onCompareResult]);

  const summaryQuery = useQuery({
    queryKey: ["compare-summary", repoKey, changeQuery.data?.changeSet?.headSha],
    queryFn: () => fetchSummary(repoKey),
    enabled: changeModeIsActive(compareMode) && changeQuery.data !== undefined,
    staleTime: Infinity,
    retry: false,
  });

  return (
    <div className="absolute left-1/2 top-3 z-20 w-[26rem] max-w-[calc(100%-7rem)] -translate-x-1/2">
      <div
        role="tablist"
        aria-label="Compare view mode"
        className="flex gap-1 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-1 backdrop-blur-sm"
      >
        {MODES.map(([value, label, hint]) => (
          <button
            key={value}
            type="button"
            role="tab"
            title={value === "workdir" ? `${hint} (next phase)` : hint}
            aria-selected={compareMode === value}
            disabled={value === "workdir"}
            onClick={() => setCompareMode(value)}
            className={
              compareMode === value
                ? "flex-1 rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-950 disabled:opacity-40"
                : "flex-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-zinc-400"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {compareMode === "prev" && (
        <div className="mt-2 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-3 backdrop-blur-sm">
          <DiffSummary
            changeQuery={changeQuery}
            summaryQuery={summaryQuery}
          />
        </div>
      )}
    </div>
  );
}

function changeModeIsActive(mode: CompareMode): mode is "prev" {
  return mode === "prev";
}

type UseQueryResultLike<T> = {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data?: T;
};

function DiffSummary({
  changeQuery,
  summaryQuery,
}: {
  changeQuery: UseQueryResultLike<AnalyzeResponse>;
  summaryQuery: UseQueryResultLike<{ summary: string; cached: boolean }>;
}) {
  if (changeQuery.isPending) {
    return <p className="text-[11px] text-zinc-500">comparing with the previous commit…</p>;
  }
  if (changeQuery.isError || changeQuery.data === undefined) {
    return (
      <p role="alert" className="text-[11px] leading-relaxed text-red-400">
        {changeQuery.error?.message ?? "Compare unavailable"}
      </p>
    );
  }

  const changeSet: ChangeSet | undefined = changeQuery.data.changeSet;
  if (changeSet === undefined) {
    return <p className="text-[11px] text-zinc-500">no change data in this analysis</p>;
  }
  const parts: string[] = [];
  if (changeSet.counts.modified > 0) parts.push(`${changeSet.counts.modified} modified`);
  if (changeSet.counts.added > 0) parts.push(`${changeSet.counts.added} added`);
  if (changeSet.counts.deleted > 0) parts.push(`${changeSet.counts.deleted} deleted`);
  if (changeSet.counts.renamed > 0) parts.push(`${changeSet.counts.renamed} renamed`);

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          HEAD vs. HEAD~1
        </p>
        <p className="font-mono text-[10px] text-zinc-400">
          {parts.length > 0 ? parts.join(" · ") : "clean — nothing changed"}
        </p>
      </div>
      <div className="mt-2">
        {summaryQuery.isPending ? (
          <p className="text-[11px] text-zinc-500">summarizing the commit…</p>
        ) : summaryQuery.isError ? (
          <p role="alert" className="text-[11px] leading-relaxed text-red-400">
            {summaryQuery.error?.message}
          </p>
        ) : summaryQuery.data ? (
          <p className="text-[11px] leading-relaxed text-zinc-300">{summaryQuery.data.summary}</p>
        ) : null}
      </div>
    </div>
  );
}
