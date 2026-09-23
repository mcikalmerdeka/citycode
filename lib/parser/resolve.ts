import path from "node:path";
import type { ImportEdge } from "../types";
import type { ExtractedImport } from "./extract";

/** Result of resolving one file's imports against the set of known file ids. */
export interface ImportResolution {
  /** Intra-repo edges (importer → imported), deduped, sorted by (toId, symbol). */
  edges: ImportEdge[];
  /** Bare/alias specifiers that can never be edges, sorted and deduped. */
  external: string[];
  /** Relative specifiers matching no known file, sorted and deduped. */
  unresolved: string[];
}

/**
 * Candidate suffixes tried in FIXED order for every relative specifier —
 * determinism is a hard requirement, so this order must never vary:
 * as-is (only .ts/.tsx ids can match), then `.ts`, `.tsx`, `/index.ts`,
 * `/index.tsx`.
 */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"] as const;

/**
 * Resolve one file's import statements against the ids of known source files.
 *
 * Rules (Phase 1 scope):
 * - ONLY `./` and `../` specifiers can become edges.
 * - Bare specifiers ("react") and path aliases ("@/lib/x") are recorded as
 *   `external` — never edges. (tsconfig-path alias resolution is out of scope.)
 * - A relative specifier matching no candidate is recorded as `unresolved` —
 *   no edge, no crash.
 * - Statements naming symbols produce one edge per symbol; statements without
 *   named symbols (default / namespace / side-effect / star) produce a single
 *   bare edge. Exact (fromId, toId, symbol) duplicates are deduped.
 */
export function resolveImports(
  fromId: string,
  imports: readonly ExtractedImport[],
  knownIds: ReadonlySet<string>
): ImportResolution {
  const edges: ImportEdge[] = [];
  const external: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const statement of imports) {
    const specifier = statement.specifier;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      external.push(specifier);
      continue;
    }
    const target = resolveSpecifier(fromId, specifier, knownIds);
    if (target === undefined) {
      unresolved.push(specifier);
      continue;
    }
    if (statement.symbols.length === 0) {
      addEdge(edges, seen, fromId, target);
    } else {
      for (const symbol of statement.symbols) {
        addEdge(edges, seen, fromId, target, symbol);
      }
    }
  }

  edges.sort(compareEdges);
  return { edges, external: dedupeSorted(external), unresolved: dedupeSorted(unresolved) };
}

/**
 * Map a relative specifier to a known file id, or undefined.
 * All math is POSIX-style because file ids are POSIX-style — never path.win32.
 */
function resolveSpecifier(
  fromId: string,
  specifier: string,
  knownIds: ReadonlySet<string>
): string | undefined {
  const dir = path.posix.dirname(fromId);
  const joined = path.posix.normalize(path.posix.join(dir, specifier));
  if (joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined)) {
    // Escapes the repo root — can never be an intra-repo file id.
    return undefined;
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = joined + suffix;
    if (knownIds.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function addEdge(
  edges: ImportEdge[],
  seen: Set<string>,
  fromId: string,
  toId: string,
  symbol?: string
): void {
  // Real symbols are non-empty identifiers, so "" can never collide with one.
  const key = `${fromId}\u0000${toId}\u0000${symbol ?? ""}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  edges.push(symbol === undefined ? { fromId, toId } : { fromId, toId, symbol });
}

function compareEdges(a: ImportEdge, b: ImportEdge): number {
  if (a.toId !== b.toId) {
    return a.toId < b.toId ? -1 : 1;
  }
  const sa = a.symbol ?? "";
  const sb = b.symbol ?? "";
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function dedupeSorted(specifiers: string[]): string[] {
  return [...new Set(specifiers)].sort();
}
