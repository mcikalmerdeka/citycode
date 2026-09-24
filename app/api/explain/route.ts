import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { getStoredGraph, getCachedSummary, rememberSummary } from "@/lib/llm/graphCache";
import { explainFile } from "@/lib/llm/prompts";
import { loadSnapshot } from "@/lib/snapshot/load";
import { saveSnapshot } from "@/lib/snapshot/save";

/**
 * POST /api/explain — Phase 3 click-to-inspect backend.
 *
 * Body: { repoKey, fileId }. The graph must have been produced by
 * /api/analyze on this server run (in-memory graph store); explanations are
 * cached per (repoKey, headSha, fileId) so the same click is ever one LLM
 * call — repeat clicks are instant and served from cache.
 *
 * Phase 6 adds the persisted tier: before calling the LLM, the route checks
 * the repo's snapshot file (lib/snapshot/) for a summary generated in a
 * PREVIOUS server run — reloading a saved city triggers zero LLM calls for
 * previously explained files (PRD risk §11). Fresh summaries are written
 * back into the snapshot, stamped with the file's disk stats so a later
 * rebuild can carry them over while the file is untouched.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey or fileId
 * - 503 missing LLM configuration (city stays usable; UI shows a banner)
 * - 502 upstream LLM failure
 */
export const runtime = "nodejs";

interface ExplainBody {
  repoKey?: unknown;
  fileId?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: ExplainBody;
  try {
    body = (await request.json()) as ExplainBody;
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  const { repoKey, fileId } = body;
  if (typeof repoKey !== "string" || repoKey.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: repoKey" }, { status: 400 });
  }
  if (typeof fileId !== "string" || fileId.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: fileId" }, { status: 400 });
  }

  const graph = getStoredGraph(repoKey);
  if (graph === undefined) {
    return NextResponse.json(
      { error: "CityCode: unknown repoKey — analyze the repo in this server session first" },
      { status: 400 },
    );
  }

  const file = graph.files.find((candidate) => candidate.id === fileId);
  if (file === undefined) {
    return NextResponse.json({ error: "CityCode: unknown fileId for this repo" }, { status: 400 });
  }

  const cachedSummary = getCachedSummary(repoKey, graph.headSha, fileId);
  if (cachedSummary !== undefined) {
    return NextResponse.json({ summary: cachedSummary, cached: true }, { status: 200 });
  }

  // Phase 6 persisted tier: a summary from a previous server run.
  // (Missing/corrupt snapshot → undefined → normal LLM path; never crashes.)
  const snapshot = loadSnapshot(repoKey, graph.headSha);
  const persisted = snapshot?.llmSummaries[fileId];
  if (persisted !== undefined) {
    rememberSummary(repoKey, graph.headSha, fileId, persisted.text);
    return NextResponse.json({ summary: persisted.text, cached: true }, { status: 200 });
  }

  try {
    // Config check happens via the shared client; a missing key aborts with
    // its readable LlmConfigError message (503, degrades — no crash).
    getLlmClient();
    const { summary } = await explainFile(graph, file);
    rememberSummary(repoKey, graph.headSha, fileId, summary);
    // Persist into the snapshot (best-effort, atomic — see save.ts), stamped
    // with the file's disk stats so rebuilds can carry it over while the
    // file is untouched. GitHub snapshots carry empty stats (re-clones get
    // fresh mtimes) — their entries simply never carry over, by design.
    if (snapshot !== undefined) {
      const stats = snapshot.fileStats[fileId];
      snapshot.llmSummaries[fileId] = {
        text: summary,
        size: stats?.size ?? 0,
        mtimeMs: stats?.mtimeMs ?? 0,
      };
      saveSnapshot(snapshot, repoKey, graph.headSha);
    }
    return NextResponse.json({ summary, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: explanation failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
