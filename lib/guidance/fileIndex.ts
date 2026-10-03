/**
 * File index for the guide prompt — a deterministic, bounded catalogue of the
 * files the model is allowed to cite.
 *
 * The model can only reference what it is shown, and anything it cites is
 * re-checked by ground.ts. For small repos the index is every source file;
 * for large ones it is the files that matter most for tracing flows:
 * entry points (nothing imports them, they import things), hubs (heavily
 * imported), and sizeable modules. Test files and tooling folders never make
 * the index — a workflow routed through a test or a dot-directory is not
 * something a newcomer can do with the app (unless the repo has nothing else).
 */

import type { CodeGraph, FileNode } from "../types";

const ENTRY_STEMS = new Set([
  "index", "main", "app", "server", "cli", "route", "page", "manage", "wsgi", "asgi", "urls", "handler",
]);

const MAX_FNS_LISTED = 8;
const MAX_SYMBOLS_PER_EDGE = 3;

export interface IndexEntry {
  file: FileNode;
  fanIn: number;
  fanOut: number;
  /** Nobody imports it, and it either imports things or looks like an entry point. */
  entry: boolean;
}

function stemOf(id: string): string {
  const name = id.slice(id.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** Test/spec/fixture paths across the supported languages (TS/TSX and Python). */
export function isTestPath(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|__mocks__|fixtures?)\//.test(lower) ||
    /\.(test|spec)\.[a-z]+$/.test(lower) ||
    /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/.test(lower)
  );
}

/**
 * Tooling and agent scaffolding — anything under a dot-directory
 * (`.agents/`, `.storybook/`, `.github/`…). It is parsed into the city like
 * any source, but it is never part of what the app does for a user, so a
 * workflow routed through it would be nonsense.
 */
export function isToolingPath(id: string): boolean {
  return id.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

/**
 * The most trace-worthy files, best first (score desc, id asc — total order,
 * so the same graph always yields the same index).
 */
export function rankIndexFiles(graph: CodeGraph, max: number): IndexEntry[] {
  const importers = new Map<string, Set<string>>();
  const importees = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    addTo(importers, edge.toId, edge.fromId);
    addTo(importees, edge.fromId, edge.toId);
  }

  const candidates = graph.files.filter((file) => !isTestPath(file.id) && !isToolingPath(file.id));
  const pool = candidates.length >= 3 ? candidates : graph.files;

  const scored = pool.map((file) => {
    const fanIn = importers.get(file.id)?.size ?? 0;
    const fanOut = importees.get(file.id)?.size ?? 0;
    const entry = fanIn === 0 && (fanOut > 0 || ENTRY_STEMS.has(stemOf(file.id)));
    const score = fanIn * 3 + fanOut + (entry ? 25 : 0) + Math.min(file.loc, 400) / 100;
    return { file, fanIn, fanOut, entry, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.file.id < b.file.id ? -1 : a.file.id > b.file.id ? 1 : 0));
  return scored.slice(0, max).map(({ file, fanIn, fanOut, entry }) => ({ file, fanIn, fanOut, entry }));
}

/** One catalogue line: `path (N loc, entry) fns: a, b, c`. */
export function describeIndexEntry(entry: IndexEntry): string {
  const { file } = entry;
  const names = file.functions.slice(0, MAX_FNS_LISTED).map((fn) => fn.name);
  const more = file.functions.length - names.length;
  const fns = names.length === 0 ? "" : ` fns: ${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
  return `${file.id} (${file.loc} loc${entry.entry ? ", entry" : ""})${fns}`;
}

/**
 * Import edges among the indexed files, grouped per importer:
 * `a.ts -> b.ts{sym1,sym2}, c.ts`. Tells the model which hand-offs are real.
 */
export function indexEdgeLines(graph: CodeGraph, ids: ReadonlySet<string>, maxLines: number): string[] {
  const byFrom = new Map<string, Map<string, Set<string>>>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.fromId) || !ids.has(edge.toId) || edge.fromId === edge.toId) continue;
    let targets = byFrom.get(edge.fromId);
    if (targets === undefined) {
      targets = new Map();
      byFrom.set(edge.fromId, targets);
    }
    let symbols = targets.get(edge.toId);
    if (symbols === undefined) {
      symbols = new Set();
      targets.set(edge.toId, symbols);
    }
    if (edge.symbol !== undefined) symbols.add(edge.symbol);
  }
  return [...byFrom.keys()]
    .sort()
    .slice(0, maxLines)
    .map((from) => {
      const targets = [...byFrom.get(from)!.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([to, symbols]) => {
          const named = [...symbols].sort().slice(0, MAX_SYMBOLS_PER_EDGE);
          return named.length === 0 ? to : `${to}{${named.join(",")}}`;
        });
      return `${from} -> ${targets.join(", ")}`;
    });
}
