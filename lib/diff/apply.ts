/**
 * Diff → city classification (Phase 4) — `lib/diff/apply.ts` from the plan.
 *
 * Pure mapping: a {@link CommitDiff} (Phase 4) or a {@link WorkdirDiff}
 * (Phase 5) + the {@link CodeGraph} built from the repo →
 * a {@link ChangeSet} the renderer consumes. No fs, no git, no LLM.
 *
 * Rules encoded here (PRD §7.3/§7.4 + the Phase 2 visual contract):
 * - modified → "construction" (orange site + animated crane marker)
 * - added → "fresh" (lime-green fresh construction) — commit compare only
 * - untracked (workdir mode: untracked on disk or staged new) → "foundation"
 *   (freshly-poured low slab — deliberately NOT yet a building)
 * - deleted → "rubble" (grey slab at the deleted file's old district spot)
 * - renamed → "moved" (cyan marker from the old spot to the new building)
 * - Blast radius = transitive closure over REVERSE import edges (who imports
 *   a changed file); every affected, non-changed node gets the "blast" red
 *   tint — color is reserved for exactly this.
 *
 * The compare view renders on the HEAD graph's layout (PRD risk §11): this
 * module must never trigger re-layout, and it never touches the layout —
 * deleted files carry no position here at all; the renderer derives their
 * rubble spot from {@link parentDistrict}.
 */

import type { ChangeKind, ChangedFile, CommitDiff } from "../git/diff";
import type { WorkdirDiff } from "../git/workdir";
import type { CodeGraph } from "../types";

/** Visual status of one node in the compare view. */
export type NodeStatus = "construction" | "fresh" | "rubble" | "moved" | "blast" | "foundation";

/** One classified node in the compare view. */
export interface NodeChange {
  /**
   * {@link CodeGraph.files} id the change applies to. For deletions this is
   * the deleted file's path (which has no building in the HEAD graph — the
   * renderer turns it into rubble); for renames the NEW path.
   */
  fileId: string;
  status: NodeStatus;
  /** Original path — renames only (drives the moved-from marker). */
  oldPath?: string;
}

/** The classified change a compare view renders. */
export interface ChangeSet {
  /** Sha of the newer commit — "" when the diff had no head sha. */
  headSha: string;
  /** Sha of the older commit — "" when the diff had no base sha. */
  baseSha: string;
  /** Every classified node (changed files + blast radius), sorted by fileId. */
  changes: NodeChange[];
  /** Per-kind counts of the directly changed files (blast radius excluded). */
  counts: {
    modified: number;
    added: number;
    deleted: number;
    renamed: number;
    /** Workdir compare only — files new to HEAD (untracked on disk or staged). */
    untracked: number;
  };
  /**
   * Workdir fingerprint from the Phase 5 workdir diff — undefined for
   * commit-to-commit compares. Feeds Phase 6 snapshot invalidation.
   */
  workdirHash?: string;
}

/**
 * Classify a commit diff against the graph built at HEAD:
 * direct changes from the diff, plus the transitive blast radius.
 *
 * `-M` renames where both endpoints fall outside the HEAD graph degrade
 * gracefully: the old path may not resolve to any rubble/marker position —
 * the renderer simply shows what positions it can resolve ({@link parentDistrict}).
 */
export function applyCommitDiff(graph: CodeGraph, diff: CommitDiff): ChangeSet {
  return classify(graph, diff.files, diff.headSha, diff.baseSha ?? "", false);
}

/**
 * Classify a working-directory change set against the graph built from the
 * folder on disk (Phase 5): the same blast-radius machinery as
 * {@link applyCommitDiff}, but new-to-HEAD files map to the "foundation"
 * status instead of "fresh" — a freshly-poured foundation is deliberately
 * not yet a full building (PRD §6 metaphor row).
 */
export function applyWorkdirDiff(graph: CodeGraph, diff: WorkdirDiff): ChangeSet {
  return classify(graph, diff.files, diff.headSha, "", true, diff.workdirHash);
}

/** Direct diff kind → visual status, per compare mode. */
const COMMIT_STATUS: Record<ChangeKind, NodeStatus> = {
  modified: "construction",
  added: "fresh",
  deleted: "rubble",
  renamed: "moved",
  // Commit-to-commit diffs never emit "untracked" — defensive fallthrough.
  untracked: "rubble",
};

const WORKDIR_STATUS: Record<ChangeKind, NodeStatus> = {
  modified: "construction",
  added: "foundation",
  deleted: "rubble",
  renamed: "moved",
  untracked: "foundation",
};

function statusForKind(kind: ChangeKind): NodeStatus {
  return COMMIT_STATUS[kind];
}

function statusForWorkdirKind(kind: ChangeKind): NodeStatus {
  return WORKDIR_STATUS[kind];
}

/** The shared classification: direct changes + transitive reverse-edge closure. */
function classify(
  graph: CodeGraph,
  files: readonly ChangedFile[],
  headSha?: string,
  baseSha?: string,
  workdirMode = false,
  workdirHash?: string,
): ChangeSet {
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 };
  const changes = new Map<string, NodeChange>();
  const directIds = new Set<string>();

  for (const file of files) {
    if (file.kind === "untracked") counts.untracked++;
    else counts[file.kind]++;
    const status = workdirMode ? statusForWorkdirKind(file.kind) : statusForKind(file.kind);
    const change: NodeChange = { fileId: file.path, status };
    if (file.oldPath !== undefined) change.oldPath = file.oldPath;
    changes.set(change.fileId, change);
    directIds.add(change.fileId);
    // A rename's old spot is rendered from the same record; it never becomes
    // rubble — track it as another direct id so the closure skips it.
    if (file.oldPath !== undefined) directIds.add(file.oldPath);
  }

  // Blast radius: importers of any directly changed file, transitively, over
  // the reverse edges (fromId imports → toId imported). Deleted and untracked
  // files have no edges of their own in the captured graph, so they open the
  // closure only when their id also exists as a node.
  const importers = buildReverseAdjacency(graph);
  const frontier = [...changes.keys()].filter((id) => importers.has(id));
  const blastSeen = new Set<string>(directIds);
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const importer of importers.get(current) ?? []) {
      if (blastSeen.has(importer)) continue;
      blastSeen.add(importer);
      frontier.push(importer);
      if (!changes.has(importer)) {
        changes.set(importer, { fileId: importer, status: "blast" });
      }
    }
  }

  const result: ChangeSet = {
    headSha: headSha ?? "",
    baseSha: baseSha ?? "",
    changes: [...changes.values()].sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0)),
    counts,
  };
  if (workdirHash !== undefined) result.workdirHash = workdirHash;
  return result;
}

/** Reverse adjacency: changed file id → the file ids that import it. */
function buildReverseAdjacency(graph: CodeGraph): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    let bucket = reverse.get(edge.toId);
    if (bucket === undefined) {
      bucket = new Set();
      reverse.set(edge.toId, bucket);
    }
    bucket.add(edge.fromId);
  }
  return reverse;
}

/**
 * The district block that (logically) contains a file's spot on the map —
 * used by the renderer to place rubble / moved-from markers for files that
 * have no building in the HEAD layout.
 *
 * Longest directory-prefix match wins, so "lib/parser/extract.ts" whose exact
 * folder vanished resolves to its closest surviving ancestor block ("lib").
 * Falls back to null → the renderer uses the city origin.
 */
export function parentDistrict(
  districts: ReadonlyArray<{ path: string }>,
  filePath: string,
): { path: string } | null {
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  let best: { path: string } | null = null;
  for (const district of districts) {
    if (dir === district.path || dir.startsWith(district.path + "/")) {
      if (best === null || district.path.length > best.path.length) {
        best = district;
      }
    }
  }
  if (best !== null) {
    return best;
  }
  // The file's own folder is gone (root-level deletion or folder rename) —
  // fall back to the shallowest surviving district so rubble still lands on
  // the city map instead of floating off-grid.
  return districts.length > 0 ? districts.reduce((a, b) => (b.path.length < a.path.length ? b : a)) : null;
}
