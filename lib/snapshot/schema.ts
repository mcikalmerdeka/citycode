/**
 * Snapshot schema (Phase 6) — `lib/snapshot/schema.ts` from the plan.
 *
 * A snapshot is the entire persistence layer of CityCode (PRD §4 non-goal:
 * no database, no migrations): one JSON file per analyzed repo state under
 * `.citycode-cache/snapshots/`, written atomically by save.ts and read back
 * by load.ts. A snapshot capture is everything a reload needs to skip
 * clone + parse + LLM calls: the graph, its frozen layout, the build
 * warnings, and both kinds of LLM output (per-file explanations and
 * per-compare-view change summaries).
 *
 * Versioning: `version` gates the shape. load.ts treats any file whose
 * version differs (or whose structure fails the guard) as a cache miss —
 * corrupt or stale-format snapshots are silently regenerated, never crash.
 */

import type { CityLayout } from "../city/layout";
import type { BuildWarning } from "../parser/buildGraph";
import type { CodeGraph, GraphSource } from "../types";

/**
 * Bump when the Snapshot shape changes; mismatching files are cache misses.
 * v2: layout metrics changed (larger world, footprint shrink + cap) — old
 * snapshots would serve stale, denser city geometry.
 */
export const SNAPSHOT_VERSION = 2;

/**
 * One persisted per-file explanation. `size`/`mtimeMs` are the source
 * file's stats at the moment the summary was generated; when a later
 * re-import rebuilds the snapshot, save.ts keeps only entries whose stats
 * still match — an edited file's summary is dropped, an untouched file's
 * summary survives (PRD risk §11: never re-trigger LLM calls unnecessarily).
 */
export interface SnapshotSummary {
  text: string;
  size: number;
  mtimeMs: number;
}

/** Per-file disk stats captured alongside the graph (local sources only). */
export type SnapshotFileStats = Record<string, { size: number; mtimeMs: number }>;

/**
 * Keys of `compareSummaries`: `"<mode>:<stateId>"` where mode is "prev"
 * (stateId = HEAD sha — one summary per commit pair) or "workdir"
 * (stateId = workdirHash — one summary per uncommitted state).
 */
export type CompareSummarySlot = string;

/** The versioned, on-disk snapshot of one analyzed repo state. */
export interface Snapshot {
  version: number;
  /** Where the codebase came from — mirrors CodeGraph.source. */
  source: GraphSource;
  /**
   * Normalized identity used for display: the absolute forward-slashed
   * folder for local sources, the clone cache path for GitHub sources
   * (the snapshot FILE key additionally encodes the sha — see key.ts).
   */
  repoPathOrUrl: string;
  /** HEAD sha at capture time; undefined for non-git folders / empty repos. */
  headSha?: string;
  /**
   * Freshness fingerprint at capture time. Local sources: sha-256 over the
   * allowlisted source walk's (path, size, mtime) — catches uncommitted
   * edits that never move HEAD. GitHub sources: the cloned HEAD sha (the
   * clone IS the state). load validation compares this against a cheap
   * re-computation before serving.
   */
  stateFingerprint: string;
  /** Per-file stats at capture time — stamps freshly generated summaries. */
  fileStats: SnapshotFileStats;
  /** The full parsed graph — re-served verbatim on a snapshot hit. */
  graph: CodeGraph;
  /** The frozen city layout — byte-identical re-render guaranteed. */
  layout: CityLayout;
  /** Parse warnings, so the sidebar survives reloads. */
  warnings: BuildWarning[];
  /** Persisted per-file explanations (PRD risk §11, fully closed here). */
  llmSummaries: Record<string, SnapshotSummary>;
  /** Persisted one-call compare summaries, slotted by compare state. */
  compareSummaries: Record<CompareSummarySlot, string>;
  /**
   * Whole-repo guidance text (generated once per repo state by
   * /api/guidance; reopened states serve it from the snapshot). Optional —
   * pre-guidance snapshots simply omit it, exactly like `skim`.
   */
  repoGuidance?: string;
  /**
   * True when the captured graph is a Phase 7 skim build (size guard: no
   * per-file functions, no edges). Optional — pre-Phase-7 snapshots simply
   * omit it, and full builds never set it. Lets a skim snapshot hit serve
   * the same summarized-city signal the cold run did.
   */
  skim?: boolean;
  /** ISO-8601 capture time — diagnostics only, never correctness. */
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Structural guard for a parsed snapshot file. Deliberately LIGHT on the
 * nested graph/layout (the server wrote those itself; ImportForm's guards
 * re-validate for the client) — the guard's job is corruption detection:
 * truncated JSON dies at parse time, wrong versions and missing top-level
 * fields die here. Either way load.ts degrades to a cache miss.
 */
export function isSnapshot(value: unknown): value is Snapshot {
  if (!isRecord(value)) return false;
  if (value.version !== SNAPSHOT_VERSION) return false;
  if (value.source !== "local" && value.source !== "github") return false;
  if (!isStr(value.repoPathOrUrl) || !isStr(value.stateFingerprint)) return false;
  if (value.headSha !== undefined && !isStr(value.headSha)) return false;
  // Graph/layout: array-of-objects sanity, not a full FileNode re-validation.
  if (!isRecord(value.graph) || !Array.isArray(value.graph.files) || !Array.isArray(value.graph.edges)) {
    return false;
  }
  if (
    !isRecord(value.layout) ||
    !Array.isArray(value.layout.buildings) ||
    !Array.isArray(value.layout.districts) ||
    !Array.isArray(value.layout.roads)
  ) {
    return false;
  }
  if (!Array.isArray(value.warnings)) return false;
  if (!isRecord(value.llmSummaries) || !isRecord(value.compareSummaries) || !isRecord(value.fileStats)) {
    return false;
  }
  if (value.skim !== undefined && typeof value.skim !== "boolean") return false;
  if (value.repoGuidance !== undefined && !isStr(value.repoGuidance)) return false;
  return isStr(value.createdAt) && !Number.isNaN(Date.parse(value.createdAt));
}
