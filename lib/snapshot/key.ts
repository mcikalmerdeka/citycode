/**
 * Snapshot cache-key derivation (Phase 6) — `lib/snapshot/key.ts` from the
 * plan. The plan's key is (normalized source path|URL, mode, headSha), with
 * workdirHash added for workdir mode. As implemented:
 *
 * - The FILE key is (repoKey, headSha): `repoKey` already bundles the
 *   normalized source identity ("local:<forward-slashed abs folder>" /
 *   "github:<clone cache path>" — both stable across restarts), and headSha
 *   pins the compared commit state.
 * - **Mode is deliberately NOT part of the file key.** Compare views reuse
 *   the static snapshot's graph + layout verbatim (the Phase 4/5
 *   zero-layout-shift contract) and recompute only the diff — cheap git
 *   calls, no LLM, no clone, no parse. The only per-mode artifact worth
 *   persisting is the LLM change summary, which lives in the snapshot's
 *   `compareSummaries` map slotted by `compareSummarySlot(mode, stateId)`.
 *
 * Filenames hash the key (Windows-safe, no path characters) with a readable
 * source prefix for anyone browsing `.citycode-cache/snapshots/`.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/** Absolute path of the snapshot store (`<projectRoot>/.citycode-cache/snapshots`). */
export function snapshotsRoot(): string {
  // process.cwd() is the project root under both `next dev` and `next start`.
  return path.join(process.cwd(), ".citycode-cache", "snapshots");
}

/**
 * The snapshot filename for one repo state: `local-<hash>.json` or
 * `github-<hash>.json`, where the hash covers (repoKey, headSha).
 * Deterministic — the same repo state always maps to the same file.
 */
export function snapshotFileName(repoKey: string, headSha?: string): string {
  const hash = createHash("sha256")
    .update(`${repoKey}\u0000${headSha ?? "none"}`)
    .digest("hex")
    .slice(0, 16);
  const sourceTag = repoKey.startsWith("github:") ? "github" : "local";
  return `${sourceTag}-${hash}.json`;
}

/** Absolute path of the snapshot file for one repo state. */
export function snapshotFilePath(repoKey: string, headSha?: string): string {
  return path.join(snapshotsRoot(), snapshotFileName(repoKey, headSha));
}

/**
 * The `compareSummaries` slot for one compare view's LLM summary:
 * `"<mode>:<stateId>"` — mode "prev" slots by HEAD sha (stable across
 * re-toggles and reloads of the same commit pair), mode "workdir" slots by
 * the workdirHash (stable while the uncommitted state is unchanged).
 */
export function compareSummarySlot(mode: "prev" | "workdir", stateId: string | undefined): string {
  return `${mode}:${stateId ?? "none"}`;
}
