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
