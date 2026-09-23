/**
 * Shared graph model for CityCode — the single shape every layer renders from.
 *
 * The static view (Phase 2) and both compare modes (Phases 4/5) consume this
 * exact structure, and Phase 6 persists it verbatim into snapshots. That makes
 * two properties load-bearing:
 *
 * 1. **Determinism** — identical input MUST produce byte-identical JSON
 *    (arrays sorted, fixed key order, no timestamps or randomness).
 * 2. **Portability** — node ids are repo-relative POSIX paths, so a graph is
 *    valid on any machine; only {@link CodeGraph.repoPath} is absolute.
 */

/** Grammar language of a parsed source file. Supports TypeScript and Python. */
export type FileLanguage = "typescript" | "tsx" | "python";

/**
 * A named function or class-method symbol extracted from a source file.
 * Anonymous functions and arrow-function consts are out of scope (documented
 * limitation).
 */
export interface SymbolDef {
  /** Symbol name as written in source (e.g. "greet", "render"). */
  name: string;
  /** 1-based line where the declaration starts (inclusive). */
  startLine: number;
  /** 1-based line where the declaration's last character sits (inclusive). */
  endLine: number;
}

/** A source file in the graph. */
export interface FileNode {
  /**
   * Repo-relative POSIX-style path with forward slashes, e.g.
   * "src/utils/helpers.ts". This is the join key for
   * {@link ImportEdge.fromId}/{@link ImportEdge.toId} and for later phases'
   * layouts — never absolute, never backslashes.
   */
  id: string;
  /**
   * Repo-relative POSIX-style display path — identical to {@link id}.
   * Kept as a distinct field because the shared shape mandates it; the only
   * absolute path allowed anywhere in the graph is {@link CodeGraph.repoPath}.
   */
  path: string;
  /** Line count of the file (newline count, +1 when the last line is unterminated). */
  loc: number;
  /** Grammar language used to parse this file. */
  language: FileLanguage;
  /** Named functions + class methods, sorted by (startLine, name). */
  functions: SymbolDef[];
  /**
   * Module specifiers that can never become intra-repo edges — bare packages
   * ("react") and tsconfig path aliases ("@/lib/x"). Sorted and deduped.
   */
  externalImports: string[];
  /**
   * Relative specifiers ("./x", "../y") that matched no known source file.
   * Recorded for diagnostics only — never edges. Sorted and deduped.
   */
  unresolvedImports: string[];
}

/**
 * A directed import edge: importer → imported.
 *
 * Direction is load-bearing: Phase 4's blast radius is the transitive closure
 * over REVERSE edges (who imports a changed file), so `fromId` must always be
 * the importing file.
 */
export interface ImportEdge {
  /** {@link FileNode.id} of the importing file. */
  fromId: string;
  /** {@link FileNode.id} of the imported file. */
  toId: string;
  /**
   * Named symbol carried by this edge, when the import statement names
   * exactly this one symbol. Omitted for default / namespace / side-effect /
   * star imports (which produce a single bare edge per module pair).
   */
  symbol?: string;
}

/** Where the ingested codebase came from. */
export type GraphSource = "local" | "github";

/** The typed graph every view and compare mode renders from. */
export interface CodeGraph {
  /** All parsed source files, sorted by id. */
  files: FileNode[];
  /** All intra-repo import edges, sorted by (fromId, toId, symbol). */
  edges: ImportEdge[];
  /**
   * HEAD commit sha when the input folder is a git repo with at least one
   * commit; undefined for non-git folders and empty repos.
   */
  headSha?: string;
  /**
   * Absolute input folder path with forward slashes, e.g.
   * "E:/Personal Projects/CityCode". The ONLY place an absolute path is
   * allowed in the graph.
   */
  repoPath: string;
  /** Ingestion source: "local" for direct folders, "github" for cloned repos (Phase 3). */
  source: GraphSource;
}
