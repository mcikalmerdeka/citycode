import { simpleGit } from "simple-git";

/**
 * Commit-to-commit diff (Phase 4) — `lib/git/diff.ts` from the plan.
 *
 * `diffCommits()` answers "what changed between HEAD~1 and HEAD": a
 * name-status list (A/M/D/R, renames detected with `-M`) plus, per file, the
 * trimmed diff patch — hunk headers + raw +/- line counts. These inputs feed
 * two consumers: `lib/diff/apply.ts` (classification + blast radius) and the
 * LLM change summary (`summarizeDiff`, which wants file names + hunk headers,
 * never full patches).
 *
 * Every failure throws a fixed, human-readable Error message so the route
 * can surface it verbatim (status 400) — never raw OS/git text.
 */

/** How a file changed between the two commits. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

/** One changed file between HEAD~1 and HEAD. */
export interface ChangedFile {
  /**
   * Repo-relative POSIX path (forward slashes, quoted paths resolved by
   * `core.quotepath=off`). For renames this is the NEW path.
   */
  path: string;
  /** Classification pulled from the name-status letter. */
  kind: ChangeKind;
  /** Original path, renames/copies only (`R`/`C` rows). */
  oldPath?: string;
  /** Diff hunk headers ("@@ -12,7 +12,9 @@ …") — the LLM summary's input. */
  hunkHeaders: string[];
  /** Lines added, counted from the patch body. */
  insertions: number;
  /** Lines deleted, counted from the patch body. */
  deletions: number;
}

/** The complete commit-to-commit change record. */
export interface CommitDiff {
  /** Sha of the newer commit (HEAD). */
  headSha?: string;
  /** Sha of the older commit (HEAD~1) — undefined when unresolvable. */
  baseSha?: string;
  /** Changed files, sorted by path. */
  files: ChangedFile[];
}

/**
 * Diff HEAD against its parent commit (`HEAD~1`) — the plan's
 * `diffCommits()` entry point, i.e. `diffRefs(repo, "HEAD")`.
 */
export function diffCommits(repoPath: string): Promise<CommitDiff> {
  return diffRefs(repoPath, "HEAD");
}

export async function diffRefs(
  repoPath: string,
  headRef: string,
): Promise<CommitDiff> {
  const git = simpleGit(repoPath);

  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("CityCode: not a git repository — commit compare needs git history.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CityCode:")) throw error;
    throw new Error("CityCode: not a git repository — commit compare needs git history.");
  }

  let headSha: string;
  try {
    headSha = (await git.revparse(headRef)).trim();
  } catch {
    throw new Error("CityCode: the repository has no commits yet — nothing to compare.");
  }
  if (headSha.length === 0) {
    throw new Error("CityCode: the repository has no commits yet — nothing to compare.");
  }

  let baseSha: string | undefined;
  try {
    baseSha = (await git.revparse(`${headSha}~1`)).trim();
  } catch {
    // Repo with fewer than two commits — no previous state to diff against.
    throw new Error(
      "CityCode: this repository has only one commit — there is no previous commit to compare against yet.",
    );
  }
  if (baseSha.length === 0) {
    throw new Error(
      "CityCode: this repository has only one commit — there is no previous commit to compare against yet.",
    );
  }

  const nameStatus = await git.raw([
    "-c",
    "core.quotepath=off",
    "diff",
    "-M",
    "--name-status",
    baseSha,
    headSha,
  ]);
  const files = parseNameStatus(nameStatus);

  if (files.length > 0) {
    const fullDiff = await git.raw([
      "-c",
      "core.quotepath=off",
      "diff",
      "-M",
      "--no-color",
      baseSha,
      headSha,
    ]);
    applyPatchDetails(files, fullDiff);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { headSha, baseSha, files };
}

/** Parse `git diff -M --name-status` rows into {@link ChangedFile} stubs. */
function parseNameStatus(nameStatus: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const row of nameStatus.split("\n")) {
    if (row.trim().length === 0) continue;
    const [status, ...paths] = row.split("\t");
    const letter = status[0];
    let kind: ChangeKind;
    let path: string;
    let oldPath: string | undefined;

    if (letter === "R" || letter === "C") {
      // R/C rows carry two paths: old, then new.
      kind = "renamed";
      oldPath = paths[0];
      path = paths[1];
    } else {
      kind = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      // Copies keep the old path for context on the newest path.
      path = paths[0];
      oldPath = undefined;
    }

    if (typeof path !== "string" || path.length === 0) continue;
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

/**
 * Walk `git diff -M --no-color` sections and attach, per changed file, its
 * hunk headers and +/- line counts.
 *
 * Deletion patches have no `+++ b/…` line — they're keyed from `--- a/…`
 * instead; deletion paths in name-status already match that `a/` path.
 */
function applyPatchDetails(files: ChangedFile[], fullDiff: string): void {
  const byPath = new Map(files.map((file) => [file.path.toUpperCase(), file]));
  for (const section of fullDiff.split(/^diff --git /m)) {
    if (section.trim().length === 0) continue;
    const lines = section.split("\n");

    // Key the patch back to a changed file: rename rows via their from/to
    // headers, deletions via `--- a/path`, everything else via `+++ b/path`.
    let renameOld: string | undefined;
    let plusPath: string | undefined;
    let minusPath: string | undefined;
    const hunkHeaders: string[] = [];
    let insertions = 0;
    let deletions = 0;
    let inBody = false;

    for (const line of lines) {
      if (line.startsWith("rename from ")) {
        renameOld = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        plusPath = line.slice("rename to ".length);
      } else if (line.startsWith("+++ ")) {
        plusPath = stripGitPrefix(line.slice(4));
        inBody = true;
      } else if (line.startsWith("--- ")) {
        minusPath = stripGitPrefix(line.slice(4));
      } else if (line.startsWith("@@")) {
        hunkHeaders.push(line);
      } else if (inBody) {
        if (line.startsWith("+")) insertions++;
        else if (line.startsWith("-")) deletions++;
      }
    }

    const file =
      (plusPath !== undefined && byPath.get(plusPath.toUpperCase())) ||
      (minusPath !== undefined && byPath.get(minusPath.toUpperCase())) ||
      (renameOld !== undefined && byPath.get(renameOld.toUpperCase())) ||
      undefined;
    if (file === undefined) continue;
    if (renameOld !== undefined && file.oldPath === undefined) file.oldPath = renameOld;
    file.hunkHeaders = hunkHeaders;
    file.insertions = insertions;
    file.deletions = deletions;

    // Consume the matched file so identical path letters across two sections
    // (rename pairs) can't double-apply.
    if (plusPath !== undefined) byPath.delete(plusPath.toUpperCase());
    if (minusPath !== undefined) byPath.delete(minusPath.toUpperCase());
    if (renameOld !== undefined) byPath.delete(renameOld.toUpperCase());
  }
}

function stripGitPrefix(p: string): string {
  return p.replace(/^[ab]\//, "").trim();
}
