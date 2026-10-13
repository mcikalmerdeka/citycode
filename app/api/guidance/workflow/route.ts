import { NextResponse } from "next/server";
import { readSourceLines } from "@/lib/guidance/sources";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { LLM_MODELS, normalizeLlmModelId } from "@/lib/llm/models";
import { getCachedGuide, getCachedWorkflow, getStoredGraph, rememberWorkflow } from "@/lib/llm/graphCache";
import { traceWorkflow } from "@/lib/llm/guidePrompts";
import { loadSnapshot, loadSnapshotGuide } from "@/lib/snapshot/load";
import { updateSnapshot } from "@/lib/snapshot/save";

/**
 * POST /api/guidance/workflow — trace one workflow through the real code
 * (phase B of the guide).
 *
 * Body: { repoKey, workflowId, model? }. The workflow itself is looked up in
 * the guide for the REQUESTED model (warm cache or snapshot) — the client
 * only names it, so nothing client-supplied reaches the prompt. The model
 * reads the line-numbered source of the files on the route and returns
 * verified steps (file, line range, narration, payload, code excerpt).
 *
 * Same tiers as /api/guidance: in-memory (keyed per model) → snapshot
 * (`workflowDetails`, shared across models since traces are grounded
 * against real line numbers, not the generating model) → LLM, written back
 * to both, so each workflow is traced at most once per model per repo state.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey / unknown model id / unknown workflow
 * - 503 missing LLM configuration
 * - 502 upstream LLM failure, or a trace with nothing usable in it
 */
export const runtime = "nodejs";

interface WorkflowBody {
  repoKey?: unknown;
  workflowId?: unknown;
  model?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: WorkflowBody;
  try {
    body = (await request.json()) as WorkflowBody;
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  const { repoKey, workflowId } = body;
  if (typeof repoKey !== "string" || repoKey.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: repoKey" }, { status: 400 });
  }
  if (typeof workflowId !== "string" || workflowId.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: workflowId" }, { status: 400 });
  }
  const modelId = normalizeLlmModelId(body.model);
  if (modelId === null) {
    return NextResponse.json(
      {
        error: `CityCode: unknown model — pick one of: ${LLM_MODELS.map((model) => model.id).join(", ")}`,
      },
      { status: 400 },
    );
  }

  const graph = getStoredGraph(repoKey);
  if (graph === undefined) {
    return NextResponse.json(
      { error: "CityCode: unknown repoKey — analyze the repo in this server session first" },
      { status: 400 },
    );
  }

  const cachedDetail = getCachedWorkflow(repoKey, graph.headSha, modelId, workflowId);
  if (cachedDetail !== undefined) {
    return NextResponse.json({ detail: cachedDetail, cached: true }, { status: 200 });
  }

  const snapshot = loadSnapshot(repoKey, graph.headSha);
  const persisted = snapshot?.workflowDetails?.[workflowId];
  if (persisted !== undefined) {
    rememberWorkflow(repoKey, graph.headSha, modelId, persisted);
    return NextResponse.json({ detail: persisted, cached: true }, { status: 200 });
  }

  const guide = getCachedGuide(repoKey, graph.headSha, modelId) ?? loadSnapshotGuide(repoKey, graph.headSha, modelId);
  const workflow = guide?.workflows.find((candidate) => candidate.id === workflowId);
  if (workflow === undefined) {
    return NextResponse.json(
      { error: "CityCode: unknown workflow — close and reopen Repo Guidance to regenerate the guide" },
      { status: 400 },
    );
  }

  try {
    getLlmClient(modelId);
    const sources = await readSourceLines(
      graph,
      workflow.route.map((stop) => stop.fileId),
    );
    const { detail } = await traceWorkflow(graph, workflow, sources, modelId);
    rememberWorkflow(repoKey, graph.headSha, modelId, detail);
    updateSnapshot(repoKey, graph.headSha, (stored) => {
      stored.workflowDetails = { ...(stored.workflowDetails ?? {}), [detail.workflowId]: detail };
    });
    return NextResponse.json({ detail, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: workflow trace failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
