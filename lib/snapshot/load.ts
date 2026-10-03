/**
 * Snapshot persistence — read side (Phase 6) — `lib/snapshot/load.ts` from
 * the plan.
 *
 * A snapshot load can fail in every benign way a cache can: the file may be
 * absent (first run), truncated (crash mid-write of some older tool), zero
 * bytes, invalid JSON, a shape from a different version, or disk garbage.
 * ALL of these degrade to `undefined` — a cache miss — and the caller
 * regenerates through the normal pipeline (plan acceptance #4: "corrupt or
 * truncated snapshot → detected, silently regenerated, never crash").
 *
 * A load NEVER throws and NEVER distinguishes "missing" from "corrupt":
 * both mean the same thing to the caller.
 */

import fs from "node:fs";

import { isRepoGuide, isWorkflowDetail, type WorkflowDetail } from "../guidance/types";
import { snapshotFilePath } from "./key";
import { isSnapshot, SNAPSHOT_VERSION, type Snapshot } from "./schema";

/**
 * Guide data is optional extra on top of the city. A malformed guide (older
 * shape, hand-edited file) is dropped so it regenerates — it must never cost
 * the user a full city rebuild by failing the whole snapshot.
 */
function dropInvalidGuidance(snapshot: Snapshot): void {
  if (snapshot.repoGuide !== undefined && !isRepoGuide(snapshot.repoGuide)) {
    delete snapshot.repoGuide;
  }
  const details: unknown = snapshot.workflowDetails;
  if (details === undefined) return;
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    delete snapshot.workflowDetails;
    return;
  }
  const valid: Record<string, WorkflowDetail> = {};
  for (const [id, detail] of Object.entries(details)) {
    if (isWorkflowDetail(detail)) valid[id] = detail;
  }
  snapshot.workflowDetails = valid;
}

/**
 * Load the snapshot for (repoKey, headSha), or undefined on any failure.
 * The guard (isSnapshot) checks the version and top-level shape; nested
 * graph/layout internals are trusted to the writer (this server) — the
 * client re-validates what it renders.
 */
export function loadSnapshot(repoKey: string, headSha?: string): Snapshot | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotFilePath(repoKey, headSha), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isSnapshot(parsed)) {
    return undefined;
  }
  if (parsed.version !== SNAPSHOT_VERSION) {
    return undefined;
  }
  dropInvalidGuidance(parsed);
  return parsed;
}
