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
 * Dispatch: `.py` files use Python's module semantics (absolute dotted
 * imports anchored at the repo root / nearest top-level package + relative
 * `from . x import` levels); everything else uses the `./`-relative rules.
 *
 * TypeScript/JS rules (Phase 1 scope):
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
  if (fromId.endsWith(".py")) {
    return resolvePythonImports(fromId, imports, knownIds);
  }
  return resolveTsImports(fromId, imports, knownIds);
}

function resolveTsImports(
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

/* ------------------------------------------------------------------ *
 * Python
 * ------------------------------------------------------------------ */

/**
 * Python import semantics (v1, deliberately simple):
 * - Absolute modules (`import a.b.c`, `from a.b import f`) are anchored at
 *   the repo root, which is how first-party code is written inside a project
 *   (pip makes the project's own package look root-hosted — for a repo
 *   without a top-level package dir this covers the common flat layout; a
 *   repo whose first-party code lives under one top-level package works when
 *   imports go through that package's name).
 * - Resolution walks the dotted path from longest prefix down: `a/b/c.py`,
 *   `a/b/c/__init__.py`, `a/b.py`, `a/b/__init__.py`, `a.py`, … — first hit
 *   wins (a package wins its sub-module lookup only if the full path exists).
 * - Relative imports (`from . import x`, `from ..pkg import y`) resolve
 *   against the importer's own directory, one level up per leading dot.
 * - Absolute modules matching nothing are third-party → `external` (recorded,
 *   never edges). Relative modules matching nothing → `unresolved`.
 * - Named symbols (`from a.b import f`) → per-symbol edges; bare `import a.b`
 *   and `from a import *` → single bare edge. Duplicates deduped.
 */
function resolvePythonImports(
  fromId: string,
  imports: readonly ExtractedImport[],
  knownIds: ReadonlySet<string>,
): ImportResolution {
  const edges: ImportEdge[] = [];
  const external: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const statement of imports) {
    const modulePath = statement.specifier;

    if (modulePath.startsWith(".")) {
      // Relative: count the dots, walk up from the importer's directory.
      const level = modulePath.match(/^\.+/)![0].length;
      let base = path.posix.dirname(fromId);
      for (let up = level - 1; up > 0; up--) {
        base = path.posix.dirname(base);
        if (base === "." || base === "/") {
          break; // escaped the repo root
        }
      }
      const rest = modulePath.slice(level).replace(/^\./, "").replace(/\./g, "/");
      if (rest.length === 0) {
        // `from . import sibling` — each imported name is a sibling module
        // inside the importer's package directory.
        if (statement.symbols.length === 0) {
          unresolved.push(modulePath);
          continue;
        }
        for (const symbol of statement.symbols) {
          const target = resolvePythonModule(base, symbol, knownIds);
          if (target !== undefined) {
            addPythonEdges(edges, seen, fromId, target, [symbol]);
          } else {
            unresolved.push(`${modulePath}${modulePath === "." ? "" : "."}${symbol}`);
          }
        }
        continue;
      }
      const target = resolvePythonModule(base, rest, knownIds);
      if (target === undefined) {
        unresolved.push(modulePath);
        continue;
      }
      addPythonEdges(edges, seen, fromId, target, statement.symbols);
      continue;
    }

    // Absolute module: try repo-root-anchored resolution across prefixes.
    // Dots → slashes here; baseDir "" keeps the path repo-root-anchored.
    const target = resolvePythonModule("", modulePath.replace(/\./g, "/"), knownIds);
    if (target === undefined) {
      external.push(modulePath);
      continue;
    }
    addPythonEdges(edges, seen, fromId, target, statement.symbols);
  }

  edges.sort(compareEdges);
  return { edges, external: dedupeSorted(external), unresolved: dedupeSorted(unresolved) };
}

/**
 * Directory-relative resolution precedence, FIXED order (determinism):
 * for each dotted-path prefix from longest to shortest (falling back from
 * `a/b/c` to `a/b` to `a` — which is how `from a.b import c` lands on
 * `a/b.py` when `c` is an attribute, not a sub-module), try `.py` then
 * `__init__.py` package.
 */
const PY_CANDIDATE_SUFFIXES = [".py", "/__init__.py"] as const;

function resolvePythonModule(baseDir: string, dotted: string, knownIds: ReadonlySet<string>): string | undefined {
  const segments = dotted.length === 0 ? [] : dotted.split("/");
  if (segments.length === 0) {
    // Bare relative import (`from . import x` with no module path): the edge
    // target would be the containing directory itself — there is no file id
    // for it, so only its resolution through symbols makes sense. Symbols
    // are handled by resolvePythonImports, so nothing resolves here.
    return undefined;
  }
  for (let cut = segments.length; cut >= 1; cut--) {
    const prefix = path.posix.join(baseDir, segments.slice(0, cut).join("/"));
    for (const suffix of PY_CANDIDATE_SUFFIXES) {
      const candidate = prefix + suffix;
      if (knownIds.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Edge emission shared by the Python paths (same dedupe rules). */
function addPythonEdges(
  edges: ImportEdge[],
  seen: Set<string>,
  fromId: string,
  toId: string,
  symbols: readonly string[],
): void {
  if (symbols.length === 0) {
    addEdge(edges, seen, fromId, toId);
    return;
  }
  for (const symbol of symbols) {
    addEdge(edges, seen, fromId, toId, symbol);
  }
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
