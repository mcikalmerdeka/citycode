/**
 * GitHub graph store / example cache (Phase 3) — server-only, in-memory.
 *
 * /api/analyze stores the freshly-built graph keyed by repoKey so
 * /api/explain can look the file up server-side without the client posting
 * graph internals back. The LLM explanation cache is keyed
 * `(repoKey, headSha, fileId)` so each file is explained at most once per
 * ingested state (PRD risk §11 — full persistence lands with Phase 6
 * snapshots; this map is warm only while the server process lives).
 */

import type { CodeGraph } from "../types";
import type { CityLayout } from "../city/layout";
import type { BuildWarning } from "../parser/buildGraph";
import type { CommitDiff } from "../git/diff";
import type { WorkdirDiff } from "../git/workdir";
import { computeRepoKey } from "../repoKey";

const graphStore = new Map<string, CodeGraph>();

/** Remember the graph for a just-analyzed repo (replaces any stale entry). */
export function storeGraph(graph: CodeGraph): void {
  graphStore.set(computeRepoKey(graph), graph);
}

/** Fetch the graph previously stored by /api/analyze, if this server run built it. */
export function getStoredGraph(repoKey: string): CodeGraph | undefined {
  return graphStore.get(repoKey);
}

/* ------------------------------------------------------------------ *
 * Phase 4 — server analysis store
 *
 * Compare modes reuse the static run's graph + layout so toggling
 * "static → previous commit" provably never shifts the layout (the exact
 * same JSON is handed back), and never re-parses the repo. The diff input
 * captured at analyze time feeds /api/summarize's single LLM call.
 * ------------------------------------------------------------------ */

interface AnalysisRecord {
  graph: CodeGraph;
  layout: CityLayout;
  warnings: BuildWarning[];
}

const analysisStore = new Map<string, AnalysisRecord>();

/** Store the full analysis (graph + layout + warnings) for reuse by compare modes. */
export function storeAnalysis(record: AnalysisRecord): void {
  analysisStore.set(computeRepoKey(record.graph), record);
}

/** Fetch the analysis record for a repoKey of this server run, or undefined. */
export function getStoredAnalysis(repoKey: string): AnalysisRecord | undefined {
  return analysisStore.get(repoKey);
}

const diffStore = new Map<string, CommitDiff>();

/** Remember the commit diff captured for a repoKey's compare run. */
export function storeCommitDiff(repoKey: string, diff: CommitDiff): void {
  diffStore.set(repoKey, diff);
}

/** Fetch the commit diff stored by the latest prev-compare of this repoKey. */
export function getStoredCommitDiff(repoKey: string): CommitDiff | undefined {
  return diffStore.get(repoKey);
}

const workdirDiffStore = new Map<string, WorkdirDiff>();

/** Remember the workdir diff captured for a repoKey's "about to commit" run. */
export function storeWorkdirDiff(repoKey: string, diff: WorkdirDiff): void {
  workdirDiffStore.set(repoKey, diff);
}

/** Fetch the workdir diff stored by the latest workdir-compare of this repoKey. */
export function getStoredWorkdirDiff(repoKey: string): WorkdirDiff | undefined {
  return workdirDiffStore.get(repoKey);
}

const compareSummaryCache = new Map<string, string>();

/** Cache key for the per-commit change summary: (repoKey, headSha). */
export function compareSummaryKey(repoKey: string, headSha: string | undefined): string {
  return `${repoKey}\u0000${headSha ?? "none"}`;
}

/** Remember a freshly generated one-commit change summary. */
export function rememberCompareSummary(repoKey: string, headSha: string | undefined, summary: string): void {
  compareSummaryCache.set(compareSummaryKey(repoKey, headSha), summary);
}

/** Get a cached one-commit change summary, or undefined. */
export function getCompareSummary(repoKey: string, headSha: string | undefined): string | undefined {
  return compareSummaryCache.get(compareSummaryKey(repoKey, headSha));
}

const summaryCache = new Map<string, string>();

/** Cache key: (repoKey, headSha, fileId) — headSha "none" when undefined. */
export function explainCacheKey(repoKey: string, headSha: string | undefined, fileId: string): string {
  return `${repoKey}\u0000${headSha ?? "none"}\u0000${fileId}`;
}

/** True when this exact (repo, state, file) was already explained. */
export function isExplained(repoKey: string, headSha: string | undefined, fileId: string): boolean {
  return summaryCache.has(explainCacheKey(repoKey, headSha, fileId));
}

/** Remember a freshly generated explanation. */
export function rememberSummary(repoKey: string, headSha: string | undefined, fileId: string, summary: string): void {
  summaryCache.set(explainCacheKey(repoKey, headSha, fileId), summary);
}

/** Get a cached explanation, or undefined. */
export function getCachedSummary(repoKey: string, headSha: string | undefined, fileId: string): string | undefined {
  return summaryCache.get(explainCacheKey(repoKey, headSha, fileId));
}

/**
 * Test isolation (Phase 6 snapshot integration): clear every in-memory
 * store so a route-level test can exercise the snapshot tier, which only
 * triggers when the warm caches miss.
 */
export function resetStoresForTests(): void {
  graphStore.clear();
  analysisStore.clear();
  diffStore.clear();
  workdirDiffStore.clear();
  compareSummaryCache.clear();
  summaryCache.clear();
}
