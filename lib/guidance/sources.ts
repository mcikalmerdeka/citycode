/**
 * Source reader for workflow tracing — the only fs access in the guidance
 * layer (server-only). Files come from the graph, never from caller-supplied
 * paths: a file id that is not in the graph is never read, which is what
 * keeps this safe from path traversal.
 *
 * Best-effort like keyFiles.ts: unreadable, missing or oversized files are
 * skipped, and the trace simply has no excerpt for them.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CodeGraph } from "../types";
import { splitLines } from "./ground";

/** Skip files larger than this — a minified bundle is no useful excerpt. */
const MAX_SOURCE_BYTES = 600_000;

/** Read the lines of the given graph files; ids outside the graph are ignored. */
export async function readSourceLines(
  graph: CodeGraph,
  fileIds: readonly string[],
): Promise<Map<string, string[]>> {
  const known = new Set(graph.files.map((file) => file.id));
  const result = new Map<string, string[]>();
  for (const fileId of new Set(fileIds)) {
    if (!known.has(fileId)) continue;
    const abs = path.join(graph.repoPath, ...fileId.split("/"));
    try {
      if ((await stat(abs)).size > MAX_SOURCE_BYTES) continue;
      result.set(fileId, splitLines(await readFile(abs, "utf8")));
    } catch {
      // Unreadable file: the step just has no code excerpt (documented above).
    }
  }
  return result;
}
