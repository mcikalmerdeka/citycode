/**
 * Key-file selection for the repo guidance prompt — deterministic,
 * server-side curation. fs access lives HERE, not in prompts.ts (the
 * prompt builders stay pure functions per prompts.ts' header contract).
 *
 * Ranking (spec docs/superpowers/specs/2026-09-25-repo-guidance-design.md §5):
 *   0. README-ish files (always included, bypass the extension allowlist)
 *   1. Entry points — shallowest depth, then highest fan-in, then path asc
 *   2. Everything else — highest fan-in, then LOC desc, then path asc
 *
 * Best-effort contract: unreadable or missing files are skipped; a total
 * read failure yields an empty selection and the LLM answers from graph
 * metadata alone (never an error). Budget: max 12 files, 40 000 chars of
 * contents total, truncated with a visible marker.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeGraph, FileNode } from "../types";

export interface KeyFile {
  /** Repo-relative POSIX path of the selected file. */
  path: string;
  /** File contents, possibly truncated by the budget. */
  contents: string;
}

export interface KeyFileSelection {
  files: KeyFile[];
  /** Candidates considered but dropped by the count/char budget or read failure. */
  droppedByBudget: number;
}

const MAX_KEY_FILES = 12;
const MAX_TOTAL_CHARS = 40_000;

const README_BASENAMES = new Set(["readme.md", "readme.txt", "readme.rst"]);
const ENTRY_STEMS = new Set(["index", "main", "app", "server", "cli"]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".ts", ".tsx", ".py", ".json",
  ".toml", ".yaml", ".yml", ".cfg", ".ini",
]);

function lastSegment(id: string): string {
  return id.split("/").pop() ?? "";
}

function isReadme(id: string): boolean {
  return README_BASENAMES.has(lastSegment(id).toLowerCase());
}

/** File stem is entry-like (index/main/app/server/cli) — case-insensitive. */
function isEntry(id: string): boolean {
  const file = lastSegment(id);
  const dot = file.lastIndexOf(".");
  return dot > 0 && ENTRY_STEMS.has(file.slice(0, dot).toLowerCase());
}

function extension(id: string): string {
  const dot = lastSegment(id).lastIndexOf(".");
  return dot === -1 ? "" : lastSegment(id).slice(dot).toLowerCase();
}

function depth(id: string): number {
  return id.split("/").length - 1;
}

/** Category 0 readme / 1 entry / 2 other — lower sorts first. */
function category(id: string): number {
  if (isReadme(id)) return 0;
  if (isEntry(id)) return 1;
  return 2;
}

export async function selectKeyFiles(graph: CodeGraph): Promise<KeyFileSelection> {
  if (graph.files.length === 0) return { files: [], droppedByBudget: 0 };

  const fanIn = new Map<string, number>();
  for (const edge of graph.edges) {
    fanIn.set(edge.toId, (fanIn.get(edge.toId) ?? 0) + 1);
  }

  // Text-extension allowlist; READMEs bypass it entirely.
  const candidates: FileNode[] = graph.files.filter(
    (file) => isReadme(file.id) || TEXT_EXTENSIONS.has(extension(file.id)),
  );

  const byFanIn = (id: string): number => fanIn.get(id) ?? 0;
  const byPath = (a: FileNode, b: FileNode): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  candidates.sort((a, b) => {
    const catA = category(a.id);
    const catB = category(b.id);
    if (catA !== catB) return catA - catB;
    if (catA === 1) {
      // Entries: shallowest, then fan-in, then path.
      if (depth(a.id) !== depth(b.id)) return depth(a.id) - depth(b.id);
      if (byFanIn(a.id) !== byFanIn(b.id)) return byFanIn(b.id) - byFanIn(a.id);
      return byPath(a, b);
    }
    // Others: fan-in desc, then LOC desc, then path.
    if (byFanIn(a.id) !== byFanIn(b.id)) return byFanIn(b.id) - byFanIn(a.id);
    if (a.loc !== b.loc) return b.loc - a.loc;
    return byPath(a, b);
  });

  // Budgeted reads — skip failures, truncate at the char cap.
  const files: KeyFile[] = [];
  let dropped = 0;
  let budget = MAX_TOTAL_CHARS;
  for (const candidate of candidates) {
    if (files.length >= MAX_KEY_FILES) {
      // All remaining candidates are dropped unpicked: total = never selected.
      dropped += candidates.length - files.length - dropped;
      break;
    }
    if (budget <= 0) {
      // Budget exhausted: the rest would be marker-only stubs — drop them all.
      dropped += candidates.length - files.length - dropped;
      break;
    }
    const abs = path.join(graph.repoPath, ...candidate.id.split("/"));
    let contents: string;
    try {
      contents = await readFile(abs, "utf8");
    } catch {
      dropped += 1;
      continue;
    }
    if (contents.length > budget) {
      contents = `${contents.slice(0, budget)}\n… [truncated]`;
      budget = 0;
    } else {
      budget -= contents.length;
    }
    files.push({ path: candidate.id, contents });
  }

  return { files, droppedByBudget: dropped };
}
