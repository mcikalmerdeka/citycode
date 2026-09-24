/**
 * Snapshot persistence — write side (Phase 6) — `lib/snapshot/save.ts` from
 * the plan.
 *
 * `saveSnapshot` writes one snapshot file atomically (temp file → rename) so
 * a crash mid-write can never leave a half-valid snapshot — the worst case
 * is the previous intact file, or none (a cache miss, which regenerates).
 * Renames happen within the same directory (same volume), which is the only
 * portable atomic-rename guarantee.
 *
 * Saving is best-effort: snapshots are an optimization, never correctness —
 * if the disk refuses, the app keeps working exactly as it did in Phase 5
 * (in-memory caches, full rebuild on next run). Failure is silent by design.
 */

import fs from "node:fs";
import path from "node:path";

import { loadSnapshot } from "./load";
import { snapshotFilePath, snapshotsRoot } from "./key";
import type { Snapshot, SnapshotSummary } from "./schema";

/** Snapshot files older than this are swept (mirrors the clone sweep's policy). */
const STALE_SNAPSHOT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Atomically write `snapshot` to its (repoKey, headSha)-derived file.
 * Never throws: any failure leaves the old file intact or absent, both of
 * which load.ts treats as a cache miss.
 */
export function saveSnapshot(snapshot: Snapshot, repoKey: string, headSha?: string): void {
  const target = snapshotFilePath(repoKey, headSha);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(snapshotsRoot(), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(snapshot), "utf8");
    fs.renameSync(temp, target);
    sweepStaleSnapshots(target);
  } catch {
    // Snapshot persistence is an optimization — swallow and move on.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // nothing more to do; the temp file dies with the next sweep or reboot
    }
  }
}

/**
 * Best-effort sweep of snapshots untouched for {@link STALE_SNAPSHOT_MS}.
 * `keep` (the file just written) is never a candidate.
 */
function sweepStaleSnapshots(keep: string): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(snapshotsRoot())) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
      const file = path.join(snapshotsRoot(), name);
      if (file === keep) continue;
      if (now - fs.statSync(file).mtimeMs <= STALE_SNAPSHOT_MS) continue;
      fs.rmSync(file, { force: true });
    }
  } catch {
    // sweep is optional; never fail a save because of it
  }
}

/**
 * Load-mutate-save helper for the LLM routes: reads the snapshot for
 * (repoKey, headSha), lets `update` mutate it in place, and persists the
 * result atomically. Missing file or failing save → silent no-op (the
 * in-memory caches still hold the value for this server run).
 *
 * Single-user local tool: last-write-wins on concurrent mutations is the
 * documented trade-off (clone.ts's GIT_TERMINAL_PROMPT swap follows the
 * same single-writer assumption).
 */
export function updateSnapshot(
  repoKey: string,
  headSha: string | undefined,
  update: (snapshot: Snapshot) => void,
  loaded?: Snapshot,
): void {
  // `loaded` lets callers reuse a snapshot they just read (explain/summarize
  // read it to check for persisted summaries before calling the LLM).
  const snapshot = loaded ?? loadSnapshot(repoKey, headSha);
  if (snapshot === undefined) return;
  update(snapshot);
  saveSnapshot(snapshot, repoKey, headSha);
}

/**
 * Carry still-valid explanations into a rebuilt snapshot (pure, unit-tested).
 *
 * A snapshot rebuild happens when the state fingerprint changed — the tree
 * was edited. Per the schema's contract, a summary survives only when the
 * file it explains has the SAME (size, mtimeMs) in the fresh walk: untouched
 * files keep their explanations (no repeat LLM cost), edited/added/removed
 * files drop theirs (their content changed — a stale summary would lie).
 */
export function carryOverSummaries(
  previous: Record<string, SnapshotSummary>,
  currentStats: Record<string, { size: number; mtimeMs: number }>,
): Record<string, SnapshotSummary> {
  const carried: Record<string, SnapshotSummary> = {};
  for (const [fileId, summary] of Object.entries(previous)) {
    const stats = currentStats[fileId];
    if (stats === undefined) continue;
    if (stats.size !== summary.size || stats.mtimeMs !== summary.mtimeMs) continue;
    carried[fileId] = summary;
  }
  return carried;
}
