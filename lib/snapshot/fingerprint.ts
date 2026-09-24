/**
 * Local state fingerprint (Phase 6) — the freshness half of snapshot
 * invalidation.
 *
 * The plan's invalidation rule ("sha mismatch → regenerate") is insufficient
 * for local folders: the static city is built from the ON-DISK tree, so
 * uncommitted edits change the city without moving HEAD. Keying the snapshot
 * by sha alone would serve a stale city after every edit. The fix: a cheap
 * stat-walk fingerprint over the same tree the parser would walk (same skip
 * list, same extension allowlist — exported from lib/git/local.ts), hashing
 * each file's (path, size, mtimeMs).
 *
 * Cost: one readdir/stat per source file — no file contents are read. That
 * is still orders of magnitude cheaper than the parse it replaces on a
 * snapshot hit, and it uniformly covers git and non-git folders (branch
 * switches rewrite files → mtimes change → fingerprint changes).
 *
 * GitHub sources skip this entirely: the clone IS the state, so the remote
 * HEAD sha is the fingerprint (see the analyze route).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SKIPPED_DIRS, SOURCE_EXTENSIONS } from "../git/local";

/** One walked source file's freshness stats. */
export interface WalkStatEntry {
  size: number;
  mtimeMs: number;
}

export interface WalkFingerprint {
  /** sha-256 over the sorted (id, size, mtimeMs) lines. */
  hash: string;
  /** Per-file stats keyed by repo-relative POSIX id — stamps LLM summaries. */
  entries: Record<string, WalkStatEntry>;
}

/**
 * Fingerprint the allowlisted source tree under `root`.
 *
 * Returns null when the root itself is unreadable/missing (the caller then
 * falls through to the cold pipeline, which produces the canonical readable
 * error). Individual unreadable files are skipped from the fingerprint —
 * they will also fail the parse and surface as build warnings.
 *
 * Deterministic: entries sorted by id before hashing, so the same tree
 * always yields the same hash (mtimeMs is part of the INPUT, not noise —
 * an untouched tree repeats exactly).
 */
export function localWalkFingerprint(root: string): WalkFingerprint | null {
  const entries: Record<string, WalkStatEntry> = {};
  try {
    if (!fs.statSync(root).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  collect(root, "", entries);
  const ids = Object.keys(entries).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length === 0) {
    // No parsable sources at all — let the cold pipeline explain why.
    return null;
  }
  const hasher = createHash("sha256");
  for (const id of ids) {
    hasher.update(`${id}\u0000${entries[id].size}\u0000${entries[id].mtimeMs}\n`);
  }
  return { hash: hasher.digest("hex"), entries };
}

/** Recursive stat walk — mirrors walkSourceFiles' traversal exactly. */
function collect(dir: string, relDir: string, entries: Record<string, WalkStatEntry>): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subfolder — same policy as the parser's walker
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      if (SKIPPED_DIRS.has(dirent.name)) continue;
      const childRel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      collect(path.join(dir, dirent.name), childRel, entries);
    } else if (dirent.isFile()) {
      const ext = path.extname(dirent.name).toLowerCase();
      if (SOURCE_EXTENSIONS[ext] === undefined) continue;
      const id = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      try {
        const stats = fs.statSync(path.join(dir, dirent.name));
        entries[id] = { size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {
        // Vanished mid-walk — excluded from the fingerprint; the parse path
        // reports it as a warning.
      }
    }
  }
}
