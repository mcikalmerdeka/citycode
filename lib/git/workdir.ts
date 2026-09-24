import { createHash } from "node:crypto";
import { simpleGit } from "simple-git";

import {
  applyPatchDetails,
  type ChangeKind,
  type ChangedFile,
} from "./diff";

/**
 * Working-directory change set (Phase 5) — `lib/git/workdir.ts` from the plan.
 *
 * `workdirDiff()` answers "what am I about to commit": everything
 * `git status` would show — staged (`git diff --cached` side), unstaged
 * (`git diff` side), and untracked files — merged into ONE per-file change
 * list, plus the per-file patch details (hunk headers + line counts, the
 * same inputs the Phase 4 LLM summary consumes) for the tracked files.
 *
 * The three sources come from a single `git status --porcelain -uall` call,
 * whose XY codes already merge index + worktree per file (X = index state,
 * Y = worktree state) — no manual staged/unstaged diffing or dedupe needed.
 * Patch details come from `git diff -M HEAD`, which reports index+worktree
 * against HEAD in one pass; untracked files have no patch (they exist only
 * on disk) and keep zero counts.
 *
 * Every failure throws a fixed readable Error message (same contract as
 * `diffCommits`), so the route can surface it verbatim as a 400.
 */

/** One entry of the unified workdir change set. */
export interface WorkdirDiff {
  /** Sha of HEAD — the state the working directory is compared against. */
  headSha?: string;
  /**
   * Cheap change fingerprint: sha-256 over the `status --porcelain -uall`
   * output. Same text → same hash; any workdir mutation changes it.
   * Feeds Phase 6 cache invalidation.
   */
  workdirHash: string;
  /** Changed files, sorted by path. Untracked files carry zero patch counts. */
  files: ChangedFile[];
}

/**
 * Diff HEAD against the working directory (staged + unstaged + untracked,
 * one record per file).
 */
export async function workdirDiff(repoPath: string): Promise<WorkdirDiff> {
  const git = simpleGit(repoPath);

  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("CityCode: not a git repository — working-directory compare needs git.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CityCode:")) throw error;
    throw new Error("CityCode: not a git repository — working-directory compare needs git.");
  }

  let headSha: string;
  try {
    headSha = (await git.revparse("HEAD")).trim();
  } catch {
    throw new Error("CityCode: the repository has no commits yet — nothing to compare.");
  }
  if (headSha.length === 0) {
    throw new Error("CityCode: the repository has no commits yet — nothing to compare.");
  }

  const status = await git.raw([
    "-c",
    "core.quotepath=off",
    "status",
    "--porcelain",
    "-uall",
  ]);
  const workdirHash = createHash("sha256").update(status).digest("hex");

  const files = parseStatusRows(status);
  if (files.length > 0) {
    // One combined diff of index+worktree vs HEAD covers every tracked file
    // in the change set (staged and unstaged alike). Untracked files never
    // appear in a diff — they simply stay unmatched here.
    const fullDiff = await git.raw([
      "-c",
      "core.quotepath=off",
      "diff",
      "-M",
      "--no-color",
      "HEAD",
    ]);
    applyPatchDetails(files, fullDiff);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { headSha, workdirHash, files };
}

/**
 * Parse `git status --porcelain -uall` rows into {@link ChangedFile} stubs.
 *
 * XY semantics merged into one kind per file (PRD §7.4: the same
 * information `git status` shows):
 * - `??` → untracked (freshly-poured foundation; uncommitted new files that
 *   were staged show as `A`/`AM`/`A?` — also new, also foundation)
 * - any `D` (worktree or index) → deleted → rubble
 * - `R`/`C` in the index → renamed (porcelain row carries "old -> new")
 * - everything else (M, T, A-with-Y-modification, …) → modified → construction
 * - `!!` (ignored files) and merge-state rows are skipped — never user changes
 */
function parseStatusRows(status: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const row of status.split("\n")) {
    if (row.trim().length === 0) continue;
    if (row.length < 4) continue; // malformed short row — skip defensively

    const xy = row.slice(0, 2);
    const rest = row.slice(3);

    if (xy === "!!") continue; // ignored files are deliberately invisible

    let kind: ChangeKind;
    let path: string;
    let oldPath: string | undefined;

    if (xy === "??") {
      kind = "untracked";
      path = rest;
    } else if (xy[0] === "R" || xy[0] === "C") {
      // Index rename/copy: "<XY> old -> new"
      const arrow = rest.indexOf(" -> ");
      if (arrow === -1) continue;
      kind = "renamed";
      oldPath = rest.slice(0, arrow);
      path = rest.slice(arrow + 4);
    } else if (xy[0] === "D" || xy[1] === "D") {
      kind = "deleted";
      path = rest;
    } else if (xy[0] === "A" || xy[1] === "A") {
      // A file new to HEAD, staged or not — foundation, not a building yet.
      kind = "untracked";
      path = rest;
    } else {
      kind = "modified";
      path = rest;
    }

    if (path.length === 0) continue;
    const record: ChangedFile = {
      path,
      kind,
      hunkHeaders: [],
      insertions: 0,
      deletions: 0,
    };
    if (oldPath !== undefined) record.oldPath = oldPath;
    files.push(record);
  }
  return files;
}
