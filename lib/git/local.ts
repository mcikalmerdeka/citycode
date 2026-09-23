import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { FileLanguage } from "../types";

/**
 * Local-folder ingestion: deterministic source-file walk plus git repo
 * detection. This is the "read a local folder" half of tech-stack §4 —
 * Node's built-in fs/path for the walk, simple-git for repo questions.
 */

/** Directories never traversed — dependencies, build output, VCS internals, our own cache. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".citycode-cache",
]);

/**
 * Extension allowlist — the ONLY extensions that can become graph nodes.
 * An allowlist (not a denylist) means binaries and assets can never sneak in.
 * Supports TypeScript/TSX and Python (Phase 5.5 addition, Python stretch item).
 */
const SOURCE_EXTENSIONS: Readonly<Record<string, FileLanguage>> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
};

/** One discovered source file. */
export interface SourceFile {
  /** Repo-relative POSIX path (the future FileNode.id) — forward slashes only. */
  id: string;
  /** Absolute filesystem path used to read the file (native separators). */
  absolutePath: string;
  /** Grammar language for this file. */
  language: FileLanguage;
}

/**
 * Code extensions from OTHER languages CityCode does not support yet —
 * used only for diagnostics in the "no .ts/.tsx found" error message
 * (e.g. a cloned Python repo should explain itself).
 */
const OUTER_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".java", ".go", ".rb", ".rs", ".cs",
  ".cpp", ".c", ".swift", ".kt", ".php",
]);

/**
 * Recursively walk a local folder and collect every .ts/.tsx source file.
 *
 * Determinism: directory entries are enumerated in sorted order and the final
 * array is sorted by id, so the same folder always yields the same result —
 * a hard requirement for byte-identical graph JSON.
 *
 * Robustness: an unreadable subfolder is skipped rather than crashing the
 * walk. Symbolic links are not followed (neither directories nor files) —
 * that avoids cycles and keeps output deterministic.
 *
 * Returns one pass: `files` are the parseable sources; `otherCodeFiles`
 * counts known non-TS code extensions (a cloned Python repo explains why it
 * can't render instead of an opaque "no .ts/.tsx found").
 */
export function walkSourceFiles(root: string): {
  files: SourceFile[];
  otherCodeFiles: Record<string, number>;
} {
  const files: SourceFile[] = [];
  const otherCodeFiles: Record<string, number> = {};
  walk(root, "", files, otherCodeFiles);
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { files, otherCodeFiles };
}

function walk(
  dir: string,
  relDir: string,
  files: SourceFile[],
  otherCodeFiles: Record<string, number>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable subfolder — skip it; one weird folder must never crash the build.
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      const childRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      walk(path.join(dir, entry.name), childRel, files, otherCodeFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const language = SOURCE_EXTENSIONS[ext];
      if (language === undefined) {
        if (OUTER_CODE_EXTENSIONS.has(ext)) {
          otherCodeFiles[ext] = (otherCodeFiles[ext] ?? 0) + 1;
        }
        continue;
      }
      const id = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      files.push({ id, absolutePath: path.join(dir, entry.name), language });
    }
  }
}

/** Git-repo facts about a local folder. */
export interface RepoInfo {
  /** Whether the folder is inside a git work tree. */
  isRepo: boolean;
  /** HEAD commit sha when the repo has at least one commit; undefined otherwise. */
  headSha?: string;
}

/**
 * Detect whether `root` is a git repo and resolve its HEAD sha.
 *
 * Never throws: a non-repo folder, a repo with no commits yet, or a git
 * failure all degrade gracefully — the static view must keep working for
 * non-git folders (Phase 1 requirement).
 */
export async function getRepoInfo(root: string): Promise<RepoInfo> {
  const git = simpleGit(root);
  let isRepo = false;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    // git CLI unavailable or path unreadable — treat as non-repo; static view still works
    return { isRepo: false };
  }
  if (!isRepo) {
    return { isRepo: false };
  }
  try {
    const sha = (await git.revparse("HEAD")).trim();
    return sha.length > 0 ? { isRepo: true, headSha: sha } : { isRepo: true };
  } catch {
    // repo with no commits yet — HEAD cannot be resolved
    return { isRepo: true };
  }
}
