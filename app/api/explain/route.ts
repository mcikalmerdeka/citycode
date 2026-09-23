import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { getStoredGraph, getCachedSummary, rememberSummary } from "@/lib/llm/graphCache";
import { explainFile } from "@/lib/llm/prompts";

/**
 * POST /api/explain — Phase 3 click-to-inspect backend.
 *
 * Body: { repoKey, fileId }. The graph must have been produced by
 * /api/analyze on this server run (in-memory graph store); explanations are
 * cached per (repoKey, headSha, fileId) so the same click is ever one LLM
 * call — repeat clicks are instant and served from cache.
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

  try {
    // Config check happens via the shared client; a missing key aborts with
    // its readable LlmConfigError message (503, degrades — no crash).
    getLlmClient();
    const { summary } = await explainFile(graph, file);
    rememberSummary(repoKey, graph.headSha, fileId, summary);
    return NextResponse.json({ summary, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: explanation failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
