/**
 * Repo-key derivation (Phase 3) — the join key between /api/analyze and
 * /api/explain. Deterministic, no dependencies, safe on both server and
 * client so both sides independently derive the same key from a graph.
 */

import type { CodeGraph } from "./types";

/**
 * A stable identifier for an ingested codebase: "source:repoPath".
 * For GitHub imports `repoPath` is the clone cache path (stable across
 * re-clones of the same URL, since the layout is `<owner>/<repo>`); for
 * local imports it is the user-provided folder.
 */
export function computeRepoKey(graph: Pick<CodeGraph, "source" | "repoPath">): string {
  return `${graph.source}:${graph.repoPath}`;
}
