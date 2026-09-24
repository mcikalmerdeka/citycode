import fs from "node:fs";
import path from "node:path";
import { getRepoInfo, walkSourceFiles } from "../git/local";
import type { CodeGraph, FileLanguage, FileNode, ImportEdge } from "../types";
import { extractFromFile } from "./extract";
import type { ExtractionResult } from "./extract";
import { resolveImports } from "./resolve";

/** A non-fatal problem encountered while building the graph. */
export interface BuildWarning {
  /** Repo-relative POSIX path of the affected file. */
  path: string;
  /** Fixed, human-readable reason — deliberately free of raw OS error text so output stays deterministic. */
  message: string;
}

/** buildGraph's return: the typed graph plus any per-file warnings. */
export interface BuildGraphResult {
  graph: CodeGraph;
  warnings: BuildWarning[];
}

/**
 * File-count cutoff for full parsing (PRD §11 risk: parsing performance).
 * A repo above this many source files either opts into skim mode explicitly
 * or gets a readable error instead of freezing the browser tab.
 */
export const MAX_PARSE_FILES = 1500;

/**
 * Total-lines cutoff for full parsing — enforced mid-walk (LOC is only known
 * after each file is read, so it cannot gate at walk time). Aborting keeps
 * the error deterministic: no timings, no partial output.
 */
export const MAX_TOTAL_LOC = 400_000;

/** Options for {@link buildGraph}. */
export interface BuildGraphOptions {
  /**
   * Skim mode: build a reduced graph WITHOUT tree-sitter parsing — per-file
   * line counts only, no functions, no import edges. For repos above the
   * {@link MAX_PARSE_FILES} / {@link MAX_TOTAL_LOC} limits; the UI renders
   * district blocks with per-district file counts instead of buildings.
   */
  skim?: boolean;
  /**
   * Overridable file-count cutoff — the run's guard uses
   * `options.maxParseFiles ?? MAX_PARSE_FILES`. Intended for tests and
   * smoke scripts; callers that care only about correctness never pass it.
   */
  maxParseFiles?: number;
  /** Overridable total-LOC cutoff — see {@link maxParseFiles}. */
  maxTotalLoc?: number;
  /**
   * Transient stage feedback for the Phase 7 progress indicator. Two coarse
   * milestones only — never per file, so a huge repo cannot flood the
   * stream. Progress is UI-only plumbing: it never appears in the graph,
   * warnings or any persisted artifact, so the determinism contract is
   * untouched.
   */
  onProgress?: (event: { stage: "walked"; files: number } | { stage: "parsed" }) => void;
}

/**
 * Skim-detection helper for the UI: a graph whose files carry no parsed
 * functions and whose edges are empty — exactly the shape skim mode
 * produces. Not a proof (a tiny repo could coincidentally parse to this
 * shape), so the response's explicit `skim` flag is the primary signal;
 * this helper lets the renderer cope with skim snapshots served from the
 * Phase 6 tier, where the flag travels via `Snapshot.skim`.
 */
export function isSkimResult(graph: CodeGraph): boolean {
  return graph.files.length > 0 && graph.edges.length === 0 && graph.files.every((file) => file.functions.length === 0);
}

/**
 * The readable error thrown when a repo exceeds the size limits without
 * opting into skim mode. Deterministic by construction: only file counts
 * and the fixed limits appear — never timings or OS error text. The
 * analyze route catches this class specifically to offer the skim
 * fallback instead of failing the request.
 */
export class SkimRequiredError extends Error {
  constructor(fileCount: number, limit: number = MAX_PARSE_FILES) {
    super(
      `CityCode: this repository has ${fileCount} source files — above the ${limit} limit for full rendering. ` +
        "Re-run with skim mode to render a summarized city (district blocks with per-district file counts, no per-file buildings).",
    );
    this.name = "SkimRequiredError";
  }
}

/**
 * The readable error thrown when a repo exceeds the total-lines limit
 * mid-parse. Deterministic: only counts and the fixed limits appear.
 */
function locCutoffError(totalLoc: number, limit: number): Error {
  return new Error(
    `CityCode: this repository has ${totalLoc} lines of code — above the ${limit} limit for full rendering. ` +
      "Re-run with skim mode to render a summarized city (buildings sized by lines of code, no per-file functions or import roads).",
  );
}

/** Internal per-file record once read + parsed successfully. */
interface ParsedFile {
  id: string;
  language: FileLanguage;
  loc: number;
  extraction: ExtractionResult;
}

/**
 * Build a typed {@link CodeGraph} from a local folder: walk → parse → resolve.
 *
 * Determinism is a hard requirement (Phase 2 pixel-identical layouts, Phase 4/5
 * zero-layout-shift compare modes, Phase 6 snapshot persistence): the same
 * folder always yields byte-identical `JSON.stringify` output — files sorted
 * by id, edges sorted by (fromId, toId, symbol), fixed key order, no
 * timestamps or randomness.
 *
 * Error philosophy: a nonexistent/empty input folder throws a clear Error with
 * the path in the message; one weird file never crashes the build — unreadable
 * or parse-failing files are skipped and reported as warnings.
 */
export async function buildGraph(
  root: string,
  source: CodeGraph["source"] = "local",
  options_?: BuildGraphOptions,
): Promise<BuildGraphResult> {
  const absoluteRoot = path.resolve(root);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absoluteRoot);
  } catch (error) {
    // Phase 7: the outlet of a bad folder is a wall of distinct failures —
    // ENOENT, a permission wall, Windows MAX_PATH. Map the common codes to
    // fixed readable messages instead of claiming everything "does not exist".
    throw inputFolderError(absoluteRoot, error);
  }
  if (!stat.isDirectory()) {
    throw new Error(`CityCode: input path is not a folder: ${absoluteRoot}`);
  }

  // The walker silently skips unreadable SUBfolders, but the ROOT itself must
  // be readable — otherwise the user gets a misleading "no supported source
  // files" instead of the real permission error. Probe it up front.
  try {
    fs.readdirSync(absoluteRoot);
  } catch (error) {
    throw inputFolderError(absoluteRoot, error);
  }

  const options = options_ ?? {};

  const { files: sourceFiles, otherCodeFiles } = walkSourceFiles(absoluteRoot);
  if (sourceFiles.length === 0) {
    const otherEntries = Object.entries(otherCodeFiles).sort(([a], [b]) => (a < b ? -1 : 1));
    const otherSummary = otherEntries.map(([ext, count]) => `${count} ${ext}`).join(", ");
    throw new Error(
      `CityCode: no supported source files (.ts/.tsx/.py) found in ${absoluteRoot}` +
        (otherSummary
          ? ` — the folder does contain code CityCode cannot parse yet (${otherSummary}); ` +
            "CityCode currently supports TypeScript/TSX and Python."
          : ""),
    );
  }

  // Phase 7 large-repo guard: above the file-count cutoff, refuse full parse
  // (skim only) unless skim mode was requested.
  const maxParseFiles = options.maxParseFiles ?? MAX_PARSE_FILES;
  const maxTotalLoc = options.maxTotalLoc ?? MAX_TOTAL_LOC;
  const skim = options.skim === true;
  if (!skim && sourceFiles.length > maxParseFiles) {
    throw new SkimRequiredError(sourceFiles.length, maxParseFiles);
  }

  const repoInfo = await getRepoInfo(absoluteRoot);

  options.onProgress?.({ stage: "walked", files: sourceFiles.length });

  const warnings: BuildWarning[] = [];

  // Skim mode: read each file once for its line count (cheap fs reads, no
  // WASM parse), no function extraction, no import edges. Determinism holds
  // via the same sort discipline as full mode (nothing is timing-dependent).
  if (skim) {
    warnings.push({
      path: "(repo)",
      message: `large repository — summarized city: ${sourceFiles.length} files, per-file functions and import roads omitted; buildings sized by lines of code`,
    });
    const files: FileNode[] = [];
    let totalLoc = 0;
    for (const file of sourceFiles) {
      let source: string;
      try {
        source = stripBom(fs.readFileSync(file.absolutePath, "utf8"));
      } catch {
        warnings.push({ path: file.id, message: "skipped: file could not be read" });
        continue;
      }
      const loc = countLines(source);
      files.push({
        id: file.id,
        path: file.id,
        loc,
        language: file.language,
        functions: [],
        externalImports: [],
        unresolvedImports: [],
      });
      totalLoc += loc;
    }
    if (totalLoc > maxTotalLoc) {
      throw locCutoffError(totalLoc, maxTotalLoc);
    }
    files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    warnings.sort(compareWarnings);
    const graph: CodeGraph = {
      files,
      edges: [],
      headSha: repoInfo.headSha,
      repoPath: absoluteRoot.split(path.sep).join("/"),
      source,
    };
    return { graph, warnings };
  }

  const parsed: ParsedFile[] = [];
  let totalLoc = 0;
  for (const file of sourceFiles) {
    let source: string;
    try {
      source = stripBom(fs.readFileSync(file.absolutePath, "utf8"));
    } catch {
      warnings.push({ path: file.id, message: "skipped: file could not be read" });
      continue;
    }
    const fileLoc = countLines(source);
    totalLoc += fileLoc;
    if (totalLoc > maxTotalLoc) {
      // Mid-walk abort (fileCount check already ran): determinism cost zero
      // because the error path yields no graph at all.
      throw locCutoffError(totalLoc, maxTotalLoc);
    }
    let extraction: ExtractionResult;
    try {
      extraction = await extractFromFile(file.language, source);
    } catch {
      warnings.push({ path: file.id, message: "skipped: file could not be parsed" });
      continue;
    }
    parsed.push({ id: file.id, language: file.language, loc: fileLoc, extraction });
  }
  options.onProgress?.({ stage: "parsed" });

  // Edges may only point at files that actually became nodes — a file that
  // was skipped cannot be an edge target, so imports of it stay unresolved.
  const knownIds = new Set(parsed.map((entry) => entry.id));

  const files: FileNode[] = [];
  const edges: ImportEdge[] = [];
  for (const entry of parsed) {
    const resolution = resolveImports(entry.id, entry.extraction.imports, knownIds);
    edges.push(...resolution.edges);
    files.push({
      id: entry.id,
      path: entry.id,
      loc: entry.loc,
      language: entry.language,
      functions: entry.extraction.functions,
      externalImports: resolution.external,
      unresolvedImports: resolution.unresolved,
    });
  }

  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort(compareEdges);
  warnings.sort(compareWarnings);

  const graph: CodeGraph = {
    files,
    edges,
    headSha: repoInfo.headSha,
    repoPath: absoluteRoot.split(path.sep).join("/"),
    source,
  };
  return { graph, warnings };
}

/**
 * Line count: number of line terminators, plus one when the file is non-empty
 * and does not end with a terminator (matches editor line counts; \r\n and
 * \n both count as one terminator).
 */
function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      newlines++;
    }
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

function compareEdges(a: ImportEdge, b: ImportEdge): number {
  if (a.fromId !== b.fromId) {
    return a.fromId < b.fromId ? -1 : 1;
  }
  if (a.toId !== b.toId) {
    return a.toId < b.toId ? -1 : 1;
  }
  const sa = a.symbol ?? "";
  const sb = b.symbol ?? "";
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function compareWarnings(a: BuildWarning, b: BuildWarning): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  return a.message === b.message ? 0 : a.message < b.message ? -1 : 1;
}

/**
 * Phase 7 error surfaces: map the common fs failure codes of the input-root
 * probe to fixed, deterministic, human-readable messages. Path strings make
 * output vary per machine, which is intended here — the message must point
 * the user at THEIR folder. Unknown codes fall through to the generic text
 * (never raw `errno`, which is platform-specific noise).
 */
function inputFolderError(absoluteRoot: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new Error(`CityCode: input folder does not exist: ${absoluteRoot}`);
    case "EACCES":
    case "EPERM":
      return new Error(`CityCode: input folder cannot be read — permission denied: ${absoluteRoot}`);
    case "ENAMETOOLONG":
      return new Error(
        `CityCode: input folder path is too long for this platform (${absoluteRoot.length} characters)`,
      );
    case "ENOTDIR":
      return new Error(`CityCode: input path is not a folder: ${absoluteRoot}`);
    default:
      return new Error(`CityCode: input folder cannot be read: ${absoluteRoot}`);
  }
}

/**
 * Strip a leading UTF-8 BOM (U+FEFF) — common in Windows-authored files.
 * Left in, the BOM leaks into tree-sitter and the first line's line count;
 * stripping keeps both extraction and LOC honest for BOM'd sources.
 */
function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}
