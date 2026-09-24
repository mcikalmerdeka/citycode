"use client";

/**
 * CompareBar — the Phase 4/5 UI: the mode switch glued to the app's top
 * center plus the one-compare change summary panel.
 *
 * Zero layout shift lives here by construction: switching to a compare mode
 * POSTs /api/analyze with the CURRENT repoKey and that mode, which the
 * server answers from the stored analysis — the identical layout JSON the
 * static view already rendered. Nothing here re-runs the import form.
 *
 * Non-git static views (no HEAD sha in the graph) keep both compare buttons
 * disabled with the reason on hover — the static city still renders fine.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import type { AnalyzeResponse } from "./ImportForm";
import type { ChangeSet } from "@/lib/diff/apply";
import { useCityStore, type CompareMode } from "@/lib/store";

type ActiveCompareMode = Exclude<CompareMode, "static">;

const MODES: Array<[CompareMode, string, string]> = [
  ["static", "Static", "as the code sits now"],
  ["prev", "Previous commit", "HEAD vs. HEAD~1"],
  ["workdir", "About to commit", "HEAD vs. working directory — staged, unstaged and untracked"],
];

async function fetchSummary(
  repoKey: string,
  mode: ActiveCompareMode,
): Promise<{ summary: string; cached: boolean }> {
  const response = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey, mode }),
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
  isGitRepo,
  onCompareResult,
}: {
  repoKey: string;
  /** False when the analyzed folder is not a git repo (no HEAD sha). */
  isGitRepo: boolean;
  onCompareResult: (data: AnalyzeResponse) => void;
}) {
  const compareMode = useCityStore((state) => state.compareMode);
  const setCompareMode = useCityStore((state) => state.setCompareMode);

  const active = compareMode !== "static";

  const changeQuery = useQuery({
    queryKey: ["compare-analysis", repoKey, compareMode],
    queryFn: async (): Promise<AnalyzeResponse> => {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "local", mode: compareMode, repoKey }),
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
    enabled: active && isGitRepo,
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
    queryKey: ["compare-summary", repoKey, compareMode, summaryCacheSha(changeQuery.data?.changeSet)],
    queryFn: () => fetchSummary(repoKey, compareMode as ActiveCompareMode),
    enabled: active && changeQuery.data !== undefined,
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
        {MODES.map(([value, label, hint]) => {
          const disabled = value !== "static" && !isGitRepo;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              title={disabled ? "not a git repository — compare modes need git history" : hint}
              aria-selected={compareMode === value}
              disabled={disabled}
              onClick={() => setCompareMode(value)}
              className={
                compareMode === value
                  ? "flex-1 rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-950 disabled:opacity-40"
                  : "flex-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-zinc-400"
              }
            >
              {label}
            </button>
          );
        })}
      </div>

      {active && (
        <div className="mt-2 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-3 backdrop-blur-sm">
          {compareMode === "prev" ? <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">HEAD vs. HEAD~1</p> : <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">HEAD vs. working directory</p>}
          <DiffSummary
            mode={compareMode as ActiveCompareMode}
            changeQuery={changeQuery}
            summaryQuery={summaryQuery}
          />
        </div>
      )}
    </div>
  );
}

/** The (mode, state-sha) pair that keys the summary query — "" while pending. */
function summaryCacheSha(changeSet: ChangeSet | undefined): string {
  if (changeSet === undefined) return "";
  return changeSet.workdirHash ?? changeSet.headSha;
}

type UseQueryResultLike<T> = {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data?: T;
};

function DiffSummary({
  mode,
  changeQuery,
  summaryQuery,
}: {
  mode: ActiveCompareMode;
  changeQuery: UseQueryResultLike<AnalyzeResponse>;
  summaryQuery: UseQueryResultLike<{ summary: string; cached: boolean }>;
}) {
  if (changeQuery.isPending) {
    return (
      <p className="text-[11px] text-zinc-500">
        {mode === "workdir" ? "comparing the working directory…" : "comparing with the previous commit…"}
      </p>
    );
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
  if (changeSet.counts.untracked > 0) parts.push(`${changeSet.counts.untracked} untracked`);
  if (changeSet.counts.deleted > 0) parts.push(`${changeSet.counts.deleted} deleted`);
  if (changeSet.counts.renamed > 0) parts.push(`${changeSet.counts.renamed} renamed`);

  return (
    <div>
      <div className="mt-2 flex items-center justify-between">
        <p className="font-mono text-[10px] text-zinc-400">
          {parts.length > 0 ? parts.join(" · ") : "clean — nothing to commit"}
        </p>
      </div>
      <div className="mt-2">
        {summaryQuery.isPending ? (
          <p className="text-[11px] text-zinc-500">summarizing the changes…</p>
        ) : summaryQuery.isError ? (
          <p role="alert" className="text-[11px] leading-relaxed text-red-400">
            {summaryQuery.error?.message}
          </p>
        ) : summaryQuery.data ? (
          <p className="text-[11px] leading-relaxed text-zinc-300">
            {summaryQuery.data.summary}
            {summaryQuery.data.cached ? <span className="ml-1.5 text-zinc-600">(cached)</span> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
