/**
 * compareAccent — the pure (compareMode, status) → diorama accent mapping for
 * the Small World restyle (Unit B).
 *
 * Design rule: compare status must NEVER recolor whole building walls. In the
 * warm diorama the walls stay cream/pale; a change status is expressed only
 * through:
 * - `roofTint` — the per-instance color of the ROOF instanced mesh
 *   (instanceColor on the roof material), and
 * - `outline` — a thin emissive ring at the building base, reserved for the
 *   two statuses that need ground-level emphasis (construction sites and
 *   rubble plots).
 *
 * In "static" mode nothing is tinted: roofs keep their terracotta/slate
 * palette and no outlines are drawn. In compare modes every status maps to
 * its `COMPARE_ACCENTS` entry from `lib/city/theme.ts` (keys mirror the
 * `NodeStatus` names from `lib/diff/apply.ts`).
 */

import type { CompareMode } from "@/lib/store";
import type { NodeStatus } from "@/lib/diff/apply";
import { COMPARE_ACCENTS } from "@/lib/city/theme";

/** The accent a building's roof/base gets in a compare mode. */
export interface CompareAccent {
  /** Per-instance roof color override (instanceColor on the roof mesh). */
  roofTint?: string;
  /** Thin emissive ring color at the building base, when one is warranted. */
  outline?: string;
}

/**
 * Statuses that read as "work happening on the ground" get a base ring in
 * addition to the roof tint — construction sites and rubble plots.
 */
const OUTLINE_STATUSES: ReadonlySet<NodeStatus> = new Set(["construction", "rubble"]);

/**
 * Map a compare mode + change status to its diorama-safe accent.
 *
 * - static → `{}` (no tint, no outline — roofs stay terracotta/slate)
 * - prev/workdir + known status → `{ roofTint, outline? }` from COMPARE_ACCENTS
 * - unknown status → `{}` (defensive; never throws)
 */
export function compareAccent(compareMode: CompareMode, status: NodeStatus | string): CompareAccent {
  if (compareMode === "static") return {};
  const tint = (COMPARE_ACCENTS as Record<string, string | undefined>)[status];
  if (tint === undefined) return {};
  const accent: CompareAccent = { roofTint: tint };
  if (OUTLINE_STATUSES.has(status as NodeStatus)) accent.outline = tint;
  return accent;
}

/**
 * Deterministic gable ridge orientation for a building's pitched roof:
 * "x" means the ridge runs along the building's local x axis (gable faces
 * ±z), "z" the mirror image. Derived from a stable 32-bit hash of the fileId
 * so a building never flips orientation between renders of the same repo.
 * Exported pure for unit testing.
 */
export function roofRidgeOrientation(fileId: string): "x" | "z" {
  let hash = 7;
  for (let i = 0; i < fileId.length; i++) {
    hash = (hash * 31 + fileId.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % 2 === 0 ? "x" : "z";
}
