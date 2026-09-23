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
export async function buildGraph(root: string, source: CodeGraph["source"] = "local"): Promise<BuildGraphResult> {
  const absoluteRoot = path.resolve(root);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absoluteRoot);
  } catch {
    throw new Error(`CityCode: input folder does not exist: ${absoluteRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`CityCode: input path is not a folder: ${absoluteRoot}`);
  }

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

  const repoInfo = await getRepoInfo(absoluteRoot);

  const warnings: BuildWarning[] = [];
  const parsed: ParsedFile[] = [];
  for (const file of sourceFiles) {
    let source: string;
    try {
      source = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      warnings.push({ path: file.id, message: "skipped: file could not be read" });
      continue;
    }
    let extraction: ExtractionResult;
    try {
      extraction = await extractFromFile(file.language, source);
    } catch {
      warnings.push({ path: file.id, message: "skipped: file could not be parsed" });
      continue;
    }
    parsed.push({ id: file.id, language: file.language, loc: countLines(source), extraction });
  }

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
