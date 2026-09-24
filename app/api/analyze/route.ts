import { NextResponse } from "next/server";
import path from "node:path";

import { computeCityLayout, type CityLayout } from "@/lib/city/layout";
import { clonePathFor, cloneRepo, readCloneHeadSha, resolveRemoteHead } from "@/lib/git/clone";
import { diffCommits, type CommitDiff } from "@/lib/git/diff";
import { workdirDiff, type WorkdirDiff } from "@/lib/git/workdir";
import { getRepoInfo } from "@/lib/git/local";
import { parseGitHubUrl } from "@/lib/git/url";
import { applyCommitDiff, applyWorkdirDiff, type ChangeSet } from "@/lib/diff/apply";
import { buildGraph, type BuildGraphResult } from "@/lib/parser/buildGraph";
import { computeRepoKey } from "@/lib/repoKey";
import { localWalkFingerprint } from "@/lib/snapshot/fingerprint";
import { loadSnapshot } from "@/lib/snapshot/load";
import { carryOverSummaries, saveSnapshot } from "@/lib/snapshot/save";
import { SNAPSHOT_VERSION, type Snapshot } from "@/lib/snapshot/schema";
import {
  storeGraph,
  storeAnalysis,
  getStoredAnalysis,
  storeCommitDiff,
  storeWorkdirDiff,
} from "@/lib/llm/graphCache";

/**
 * POST /api/analyze — the single ingestion entry point: local folder or
 * GitHub URL → graph → city layout. The renderer (components/city/) only
 * ever consumes the { graph, layout } pair this route returns, so layout
 * happens once server-side and is never re-derived client-side
 * (determinism contract). A successful response also stores the analysis
 * server-side (keyed by repoKey) and reports the key back.
 *
 * Phase 4 added `mode: "prev"`; Phase 5 added `mode: "workdir"`;
 * Phase 6 adds the snapshot tier — the lookup order is:
 *
 * 1. **Warm in-memory compare** (unchanged): a compare request carrying a
 *    repoKey of this server run reuses the stored analysis verbatim.
 * 2. **Snapshot hit** (new): a saved `.citycode-cache/snapshots/<key>.json`
 *    whose state fingerprint matches returns `{ fromCache: true }` and skips
 *    clone + parse entirely (PRD §7.5). The snapshot's graph + layout are
 *    re-hydrated into the in-memory stores so /api/explain and
 *    /api/summarize keep working without a fresh analysis.
 *    - Local: fingerprint = cheap stat-walk hash of the source tree —
 *      catches uncommitted edits that never move HEAD (sha-only keys would
 *      serve stale cities after every edit).
 *    - GitHub: the intact clone's HEAD sha must match the snapshot, and a
 *      cheap `ls-remote HEAD` probe confirms the remote hasn't moved — a
 *      moved remote falls through to a fresh clone (Phase 3 semantics
 *      preserved). A failed probe (offline) is tolerated: the intact clone
 *      is still served, making reloads work without network.
 *    - Compare modes serve the snapshot's graph + layout verbatim (the
 *      frozen-layout contract) and recompute only the diff — the plan's
 *      "reuse graph + layout, recompute only the diff" rule.
 * 3. **Cold build** (unchanged): clone/walk → parse → layout, then the
 *    analysis is SAVED as a snapshot for next time (atomic write; untouched
 *    files' LLM summaries carry over).
 *
 * Every failure here is a user-input problem — bad JSON, wrong source field,
 * missing path, unreadable folder, bad GitHub URL, clone failure, empty
 * repo, single-commit repo — so everything maps to 400 with the error text;
 * nothing may bubble into a 500.
 */
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  if (body === null || typeof body !== "object") {
    return NextResponse.json(
      { error: "CityCode: request body must be a JSON object" },
      { status: 400 },
    );
  }

  // Hand-rolled validation — no zod, no new dependencies (Phase 2 rule).
  const { source, path: inputPath, repoUrl, mode, repoKey } = body as {
    source?: unknown;
    path?: unknown;
    repoUrl?: unknown;
    mode?: unknown;
    repoKey?: unknown;
  };

  if (mode !== undefined && mode !== "static" && mode !== "prev" && mode !== "workdir") {
    return NextResponse.json(
      { error: 'CityCode: unsupported mode — expected "static", "prev" or "workdir"' },
      { status: 400 },
    );
  }

  const compare = mode === "prev" || mode === "workdir";

  const diffAndClassify = async (
    repoPath: string,
    graph: BuildGraphResult["graph"],
  ): Promise<{ changeSet: ChangeSet; diff?: CommitDiff; workdirDiff?: WorkdirDiff }> => {
    if (mode === "workdir") {
      const wd = await workdirDiff(repoPath);
      return { changeSet: applyWorkdirDiff(graph, wd), workdirDiff: wd };
    }
    const d = await diffCommits(repoPath);
    return { changeSet: applyCommitDiff(graph, d), diff: d };
  };

  // Compare mode with a warm cache: reuse the exact stored analysis so the
  // layout sent back is the very same JSON the static view already rendered.
  if (compare && typeof repoKey === "string") {
    const reused = getStoredAnalysis(repoKey);
    if (reused !== undefined) {
      try {
        const { changeSet, diff, workdirDiff: wd } = await diffAndClassify(reused.graph.repoPath, reused.graph);
        if (wd !== undefined) storeWorkdirDiff(repoKey, wd);
        if (diff !== undefined) storeCommitDiff(repoKey, diff);
        return NextResponse.json(
          { graph: reused.graph, layout: reused.layout, warnings: reused.warnings, repoKey, changeSet },
          { status: 200 },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "CityCode: compare failed";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }
  }

  // Snapshot tier (Phase 6): serve a saved analysis without clone or parse.
  // Returns null when no valid snapshot applies — the cold path then runs
  // and produces the canonical errors for bad input.
  const snapHit = await trySnapshot({ source, path: inputPath, repoUrl, compare, diffAndClassify });
  if (snapHit !== null) {
    return snapHit;
  }

  try {
    // A cold compare still goes through the full pipeline and then diffs.
    const built = await ingestAndBuild({ source, path: inputPath, repoUrl });
    const key = computeRepoKey(built.graph);
    storeGraph(built.graph);
    storeAnalysis({ graph: built.graph, layout: built.layout, warnings: built.warnings });
    saveAnalysisSnapshot(built, key);

    let changeSet: ChangeSet | undefined;
    if (compare) {
      const { changeSet: set, diff, workdirDiff: wd } = await diffAndClassify(built.graph.repoPath, built.graph);
      changeSet = set;
      if (diff !== undefined) storeCommitDiff(key, diff);
      if (wd !== undefined) storeWorkdirDiff(key, wd);
    }

    return NextResponse.json(
      { graph: built.graph, layout: built.layout, warnings: built.warnings, repoKey: key, changeSet },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: analysis failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Clone/walk → graph → layout. Local path or GitHub URL; throws readable Errors. */
async function ingestAndBuild(request: {
  source?: unknown;
  path?: unknown;
  repoUrl?: unknown;
}): Promise<{ graph: BuildGraphResult["graph"]; layout: CityLayout; warnings: BuildGraphResult["warnings"] }> {
  const { source, path: inputPath, repoUrl } = request;

  if (source === "local") {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      throw new Error("CityCode: missing required field: path");
    }
    const { graph, warnings } = await buildGraph(inputPath.trim());
    return { graph, layout: computeCityLayout(graph), warnings };
  }

  if (source === "github") {
    const parsed =
      typeof repoUrl === "string" && repoUrl.trim().length > 0 ? parseGitHubUrl(repoUrl) : null;
    if (parsed === null) {
      throw new Error(
        "CityCode: the URL must be an https GitHub repo URL, e.g. https://github.com/<owner>/<repo>",
      );
    }
    const clonePath = await cloneRepo(parsed);
    const { graph, warnings } = await buildGraph(clonePath, "github");
    return { graph, layout: computeCityLayout(graph), warnings };
  }

  throw new Error('CityCode: unsupported source — expected "local" or "github"');
}

/* ------------------------------------------------------------------ *
 * Phase 6 — snapshot tier
 * ------------------------------------------------------------------ */

interface SnapshotRequest {
  source?: unknown;
  path?: unknown;
  repoUrl?: unknown;
  compare: boolean;
  diffAndClassify: (
    repoPath: string,
    graph: BuildGraphResult["graph"],
  ) => Promise<{ changeSet: ChangeSet; diff?: CommitDiff; workdirDiff?: WorkdirDiff }>;
}

/**
 * Attempt to serve the request from a saved snapshot. Returns a NextResponse
 * on a hit, or null to fall through to the cold pipeline (which owns all
 * canonical input errors — this function never surfaces one of its own).
 */
async function trySnapshot(request: SnapshotRequest): Promise<NextResponse | null> {
  const { source, path: inputPath, repoUrl, compare, diffAndClassify } = request;

  if (source === "local") {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      return null; // cold path produces the canonical "missing field" error
    }
    const root = path.resolve(inputPath.trim());
    const fingerprint = localWalkFingerprint(root);
    if (fingerprint === null) {
      return null; // missing/unreadable/no-source folder — let buildGraph explain
    }
    const repoInfo = await getRepoInfo(root);
    const repoKey = computeRepoKey({ source: "local", repoPath: forwardSlash(root) });
    const snapshot = loadSnapshot(repoKey, repoInfo.headSha);
    if (snapshot === undefined || snapshot.stateFingerprint !== fingerprint.hash) {
      return null; // first run, tree changed, or corrupt file — regenerate
    }
    return respondFromSnapshot(snapshot, repoKey, compare, diffAndClassify);
  }

  if (source === "github") {
    const parsed =
      typeof repoUrl === "string" && repoUrl.trim().length > 0 ? parseGitHubUrl(repoUrl) : null;
    if (parsed === null) {
      return null; // cold path produces the canonical URL error
    }
    const cloneDir = clonePathFor(parsed);
    const localSha = await readCloneHeadSha(cloneDir);
    if (localSha === undefined) {
      return null; // no intact clone — a fresh clone is required for diffs anyway
    }
    const repoKey = computeRepoKey({ source: "github", repoPath: forwardSlash(cloneDir) });
    const snapshot = loadSnapshot(repoKey, localSha);
    if (snapshot === undefined) {
      return null; // no snapshot for this sha — clone/parse as usual
    }
    // The clone matches the snapshot; confirm the remote hasn't moved so a
    // re-import always sees fresh HEAD (Phase 3 semantics). A failed probe
    // (offline, private) is tolerated — the intact clone is still served.
    const remoteSha = await resolveRemoteHead(parsed.httpsUrl);
    if (remoteSha !== undefined && remoteSha !== localSha) {
      return null; // remote moved — fall through to a fresh clone
    }
    return respondFromSnapshot(snapshot, repoKey, compare, diffAndClassify);
  }

  return null;
}

/** Hydrate the in-memory stores from a snapshot and answer the request. */
async function respondFromSnapshot(
  snapshot: Snapshot,
  repoKey: string,
  compare: boolean,
  diffAndClassify: SnapshotRequest["diffAndClassify"],
): Promise<NextResponse> {
  const graph = snapshot.graph;
  // Hydration: explain/summarize/compare all key off the in-memory stores,
  // so a snapshot-served run must repopulate them (server may have restarted).
  storeGraph(graph);
  storeAnalysis({ graph, layout: snapshot.layout, warnings: snapshot.warnings });

  if (!compare) {
    return NextResponse.json(
      {
        graph,
        layout: snapshot.layout,
        warnings: snapshot.warnings,
        repoKey,
        fromCache: true,
      },
      { status: 200 },
    );
  }

  try {
    const { changeSet, diff, workdirDiff: wd } = await diffAndClassify(graph.repoPath, graph);
    if (wd !== undefined) storeWorkdirDiff(repoKey, wd);
    if (diff !== undefined) storeCommitDiff(repoKey, diff);
    return NextResponse.json(
      { graph, layout: snapshot.layout, warnings: snapshot.warnings, repoKey, changeSet, fromCache: true },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: compare failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Persist a freshly built analysis for next time (plan task: "save on every
 * successful generate"). Best-effort — see save.ts for the failure policy.
 *
 * Summaries carry over per-file (same id + size + mtime in the fresh walk),
 * so editing one file does not discard the explanations of every other file
 * (PRD risk §11). Compare-summary slots are keyed by state, so stale states'
 * slots never collide with new ones — they carry over wholesale.
 */
function saveAnalysisSnapshot(
  built: { graph: BuildGraphResult["graph"]; layout: CityLayout; warnings: BuildGraphResult["warnings"] },
  repoKey: string,
): void {
  const { graph, layout, warnings } = built;
  const stale = loadSnapshot(repoKey, graph.headSha);

  let fileStats: Record<string, { size: number; mtimeMs: number }> = {};
  let stateFingerprint: string;
  let llmSummaries: Record<string, { text: string; size: number; mtimeMs: number }> = {};

  if (graph.source === "local") {
    const fingerprint = localWalkFingerprint(graph.repoPath);
    if (fingerprint === null) {
      return; // cannot fingerprint → cannot validate later; skip persistence
    }
    fileStats = fingerprint.entries;
    stateFingerprint = fingerprint.hash;
    llmSummaries = carryOverSummaries(stale?.llmSummaries ?? {}, fingerprint.entries);
  } else {
    // GitHub: the clone IS the state (fresh mtimes every re-clone, so
    // per-file carry-over can never match — start summaries empty).
    stateFingerprint = graph.headSha ?? "none";
  }

  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION,
    source: graph.source,
    repoPathOrUrl: graph.repoPath,
    headSha: graph.headSha,
    stateFingerprint,
    fileStats,
    graph,
    layout,
    warnings,
    llmSummaries,
    compareSummaries: stale?.compareSummaries ?? {},
    createdAt: new Date().toISOString(),
  };
  saveSnapshot(snapshot, repoKey, graph.headSha);
}

/** Forward slashes everywhere — snapshot keys must match graph.repoPath. */
function forwardSlash(p: string): string {
  return p.split(path.sep).join("/");
}
