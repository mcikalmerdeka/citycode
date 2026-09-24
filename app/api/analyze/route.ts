import { NextResponse } from "next/server";
import path from "node:path";

import { computeCityLayout, type CityLayout } from "@/lib/city/layout";
import { clonePathFor, cloneRepo, readCloneHeadSha, resolveRemoteHead } from "@/lib/git/clone";
import { diffCommits, type CommitDiff } from "@/lib/git/diff";
import { workdirDiff, type WorkdirDiff } from "@/lib/git/workdir";
import { getRepoInfo } from "@/lib/git/local";
import { parseGitHubUrl } from "@/lib/git/url";
import { applyCommitDiff, applyWorkdirDiff, type ChangeSet } from "@/lib/diff/apply";
import { buildGraph, SkimRequiredError, type BuildGraphResult } from "@/lib/parser/buildGraph";
import {
  NDJSON_CONTENT_TYPE,
  encodeNdjsonLine,
  isNdjsonContentType,
  type AnalysisStage,
} from "@/lib/progress";
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
 * The lookup order:
 *
 * 1. **Warm in-memory compare**: a compare request carrying a repoKey of
 *    this server run reuses the stored analysis verbatim (Phase 4).
 * 2. **Snapshot hit** (Phase 6): a saved `.citycode-cache/snapshots/<key>.json`
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
 *      frozen-layout contract) and recompute only the diff.
 * 3. **Cold build**: clone/walk → parse → layout, then the analysis is
 *    SAVED as a snapshot for next time (atomic write; untouched files' LLM
 *    summaries carry over).
 *
 * Phase 7 — hardening & polish:
 * - **Large-repo guard (PRD risk §11).** A cold build that crosses the
 *   parser's size cutoffs does NOT fail the request: the route retries the
 *   build with `skim: true` (cheap reads, no tree-sitter parse) and answers
 *   with the summarized city. The response carries `skim: true` and the
 *   build appends a readable note to `warnings` explaining what was left
 *   out — never a frozen tab.
 * - **Stage feedback (streaming).** Callers that send
 *   `Accept: application/x-ndjson` (see lib/progress.ts) get a streamed
 *   response: coarse progress lines (`{"type":"progress","stage":…}`) as
 *   milestones pass, then the exact response object as
 *   `{"type":"result","result":…}` — or `{"type":"error","error":…}` as the
 *   terminal line (streamed runs keep HTTP 200; the terminal line carries
 *   the failure). Validation failures before the pipeline starts keep the
 *   plain-JSON 400 exactly as always. Requests WITHOUT the Accept header
 *   get the original single-JSON behavior byte-for-byte — the compare flow
 *   in components/ui/CompareBar and the Phase 6 route-level tests depend
 *   on it.
 *
 * Every failure here is a user-input problem — bad JSON, wrong source field,
 * missing path, unreadable folder, bad GitHub URL, clone failure, empty
 * repo, single-commit repo — so everything maps to 400 with the error text;
 * nothing may bubble into a 500.
 */
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  if (payload === null || typeof payload !== "object") {
    return NextResponse.json(
      { error: "CityCode: request body must be a JSON object" },
      { status: 400 },
    );
  }

  const record = payload as Record<string, unknown>;
  const { mode } = record;

  if (mode !== undefined && mode !== "static" && mode !== "prev" && mode !== "workdir") {
    return NextResponse.json(
      { error: 'CityCode: unsupported mode — expected "static", "prev" or "workdir"' },
      { status: 400 },
    );
  }

  const wantsStream = isNdjsonAccept(request.headers.get("accept"));

  if (!wantsStream) {
    const { status, body } = await runAnalyzePipeline(record, undefined);
    return NextResponse.json(body, { status });
  }

  // NDJSON branch: the identical pipeline, in-band progress lines, then a
  // terminal result/error line. Streamed runs keep HTTP 200 — the terminal
  // line type disambiguates (lib/progress.ts documents the contract).
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const push = (line: string): void => {
        controller.enqueue(encoder.encode(line));
      };
      try {
        const { status, body } = await runAnalyzePipeline(record, (stage, detail) => {
          push(
            encodeNdjsonLine({
              type: "progress",
              stage,
              ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
            }),
          );
        });
        if (status === 200) {
          push(encodeNdjsonLine({ type: "result", result: body as Record<string, unknown> }));
        } else {
          const error = (body as { error?: unknown }).error;
          push(
            encodeNdjsonLine({
              type: "error",
              error: typeof error === "string" ? error : "CityCode: analysis failed",
            }),
          );
        }
      } catch (error) {
        // Unexpected pipeline failure — the streamed equivalent of the JSON
        // branch's never-a-500 catch: a readable terminal line, HTTP 200.
        const message = error instanceof Error ? error.message : "CityCode: analysis failed";
        push(encodeNdjsonLine({ type: "error", error: message }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": NDJSON_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/** True when the request opts into streaming (see lib/progress.ts). */
function isNdjsonAccept(accept: string | null): boolean {
  if (accept === null) {
    return false;
  }
  return accept.split(",").some((part) => isNdjsonContentType(part));
}

/* ------------------------------------------------------------------ *
 * Shared pipeline — one code path for both response shapes
 * ------------------------------------------------------------------ */

interface PipelineResult {
  status: 200 | 400;
  body: unknown;
}

/** Stage-notification callback — undefined on the plain-JSON branch. */
type Notify = ((stage: AnalysisStage, detail?: string) => void) | undefined;

type AnalyzeGraph = BuildGraphResult["graph"];

/**
 * The whole analysis pipeline, split out of POST so the two response shapes
 * share one code path. `notify` receives the coarse milestones; on the JSON
 * branch it is undefined and the stages cost nothing.
 */
async function runAnalyzePipeline(
  record: Record<string, unknown>,
  notify: Notify,
): Promise<PipelineResult> {
  const { source, path: inputPath, repoUrl, repoKey, mode } = record;
  const emit = (stage: AnalysisStage, detail?: string): void => notify?.(stage, detail);
  const compare = mode === "prev" || mode === "workdir";

  const diffAndClassify = async (
    repoPath: string,
    graph: AnalyzeGraph,
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
        return {
          status: 200,
          body: { graph: reused.graph, layout: reused.layout, warnings: reused.warnings, repoKey, changeSet },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "CityCode: compare failed";
        return { status: 400, body: { error: message } };
      }
    }
  }

  // Snapshot tier (Phase 6): serve a saved analysis without clone or parse.
  // Returns null when no valid snapshot applies — the cold path then runs
  // and produces the canonical errors for bad input.
  const snapHit = await trySnapshot({ source, path: inputPath, repoUrl, compare, diffAndClassify, notify });
  if (snapHit !== null) {
    return snapHit;
  }

  try {
    // A cold compare still goes through the full pipeline and then diffs.
    const built = await ingestAndBuild({ source, path: inputPath, repoUrl }, emit);
    const key = computeRepoKey(built.graph);
    storeGraph(built.graph);
    storeAnalysis({ graph: built.graph, layout: built.layout, warnings: built.warnings });

    let changeSet: ChangeSet | undefined;
    if (compare) {
      const { changeSet: set, diff, workdirDiff: wd } = await diffAndClassify(built.graph.repoPath, built.graph);
      changeSet = set;
      if (diff !== undefined) storeCommitDiff(key, diff);
      if (wd !== undefined) storeWorkdirDiff(key, wd);
    }
    emit("saving");
    saveAnalysisSnapshot(built, key);

    const body: Record<string, unknown> = {
      graph: built.graph,
      layout: built.layout,
      warnings: built.warnings,
      repoKey: key,
    };
    if (built.skim === true) body.skim = true;
    if (changeSet !== undefined) body.changeSet = changeSet;
    return { status: 200, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: analysis failed";
    return { status: 400, body: { error: message } };
  }
}

interface BuiltAnalysis {
  graph: BuildGraphResult["graph"];
  layout: CityLayout;
  warnings: BuildGraphResult["warnings"];
  /** Present when the size guard forced the skim fallback. */
  skim?: true;
}

/**
 * Build a full-or-skim analysis from a local path or GitHub URL, emitting
 * the coarse stage milestones along the way. Throws readable Errors — with
 * one internal retry (Phase 7): an over-cutoff repo raises
 * SkimRequiredError, which is retried as a skim build instead of surfacing
 * as a failure.
 */
async function ingestAndBuild(
  request: { source?: unknown; path?: unknown; repoUrl?: unknown },
  emit: (stage: AnalysisStage, detail?: string) => void,
): Promise<BuiltAnalysis> {
  const { source, path: inputPath, repoUrl } = request;

  const onProgress = graphMilestoneToStage(emit);
  const tryBuilt = async (root: string, sourceName: "local" | "github"): Promise<BuildGraphResult> => {
    try {
      return await buildGraph(root, sourceName, { onProgress });
    } catch (error) {
      if (!(error instanceof SkimRequiredError)) {
        throw error;
      }
      // Large-repo guard: fall back to the summarized city (PRD risk §11).
      return await buildGraph(root, sourceName, { skim: true, onProgress });
    }
  };

  if (source === "local") {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      throw new Error("CityCode: missing required field: path");
    }
    emit("walking");
    const builtResult = await tryBuilt(inputPath.trim(), "local");
    emit("layout");
    return finalizeBuilt(builtResult);
  }

  if (source === "github") {
    const parsed =
      typeof repoUrl === "string" && repoUrl.trim().length > 0 ? parseGitHubUrl(repoUrl) : null;
    if (parsed === null) {
      throw new Error(
        "CityCode: the URL must be an https GitHub repo URL, e.g. https://github.com/<owner>/<repo>",
      );
    }
    emit("cloning");
    const clonePath = await cloneRepo(parsed);
    emit("walking");
    const builtResult = await tryBuilt(clonePath, "github");
    emit("layout");
    return finalizeBuilt(builtResult);
  }

  throw new Error('CityCode: unsupported source — expected "local" or "github"');
}

/** buildGraph's milestones → route stages (walking / parsing "<N> files"). */
function graphMilestoneToStage(
  emit: (stage: AnalysisStage, detail?: string) => void,
): NonNullable<Parameters<typeof buildGraph>[2]>["onProgress"] {
  return (event) => {
    if (event.stage === "walked") {
      emit("parsing", `${event.files} files`);
    }
  };
}

/** Stamp `skim: true` when the built graph is a skim build (size guard). */
function finalizeBuilt(builtResult: BuildGraphResult): BuiltAnalysis {
  const { graph, warnings } = builtResult;
  const layout = computeCityLayout(graph);
  const built: BuiltAnalysis = { graph, layout, warnings };
  if (
    graph.files.length > 0 &&
    graph.edges.length === 0 &&
    graph.files.every((file) => file.functions.length === 0)
  ) {
    built.skim = true;
  }
  return built;
}

/* ------------------------------------------------------------------ *
 * Phase 6 — snapshot tier
 * ------------------------------------------------------------------ */

interface SnapshotRequest {
  source?: unknown;
  path?: unknown;
  repoUrl?: unknown;
  compare: boolean;
  notify: Notify;
  diffAndClassify: (
    repoPath: string,
    graph: AnalyzeGraph,
  ) => Promise<{ changeSet: ChangeSet; diff?: CommitDiff; workdirDiff?: WorkdirDiff }>;
}

/**
 * Attempt to serve the request from a saved snapshot. Returns a
 * PipelineResult on a hit, or null to fall through to the cold pipeline
 * (which owns all canonical input errors — this function never surfaces
 * one of its own).
 */
async function trySnapshot(request: SnapshotRequest): Promise<PipelineResult | null> {
  const { source, path: inputPath, repoUrl, compare, diffAndClassify, notify } = request;
  const emit = (stage: AnalysisStage, detail?: string): void => notify?.(stage, detail);

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
    emit("loading-snapshot");
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
    emit("loading-snapshot");
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
): Promise<PipelineResult> {
  const graph = snapshot.graph;
  // Hydration: explain/summarize/compare all key off the in-memory stores,
  // so a snapshot-served run must repopulate them (server may have restarted).
  storeGraph(graph);
  storeAnalysis({ graph, layout: snapshot.layout, warnings: snapshot.warnings });

  if (!compare) {
    const body: Record<string, unknown> = {
      graph,
      layout: snapshot.layout,
      warnings: snapshot.warnings,
      repoKey,
      fromCache: true,
    };
    if (snapshot.skim === true) body.skim = true;
    return { status: 200, body };
  }

  try {
    const { changeSet, diff, workdirDiff: wd } = await diffAndClassify(graph.repoPath, graph);
    if (wd !== undefined) storeWorkdirDiff(repoKey, wd);
    if (diff !== undefined) storeCommitDiff(repoKey, diff);
    const body: Record<string, unknown> = {
      graph,
      layout: snapshot.layout,
      warnings: snapshot.warnings,
      repoKey,
      changeSet,
      fromCache: true,
    };
    if (snapshot.skim === true) body.skim = true;
    return { status: 200, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: compare failed";
    return { status: 400, body: { error: message } };
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
function saveAnalysisSnapshot(built: BuiltAnalysis, repoKey: string): void {
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
  if (built.skim === true) snapshot.skim = true;
  saveSnapshot(snapshot, repoKey, graph.headSha);
}

/** Forward slashes everywhere — snapshot keys must match graph.repoPath. */
function forwardSlash(p: string): string {
  return p.split(path.sep).join("/");
}
