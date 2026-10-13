import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { LLM_MODELS, guideModelId, normalizeLlmModelId } from "@/lib/llm/models";
import { getCachedGuide, getStoredGraph, rememberGuide } from "@/lib/llm/graphCache";
import { designWorkflow } from "@/lib/llm/guidePrompts";
import { loadSnapshotGuide } from "@/lib/snapshot/load";
import { updateSnapshot } from "@/lib/snapshot/save";

/**
 * POST /api/guidance/ask — create a custom guided demo from a question.
 *
 * Body: { repoKey, question, model? }. The model (the session's Repo
 * Guidance model choice) designs one workflow (a route through real files)
 * that answers the question; it is grounded against the graph and APPENDED
 * to that model's repo guide — in memory and in the snapshot — so it sits in
 * the same list as the generated demos and survives reloads. Tracing it
 * through the code happens later, lazily, exactly like any other demo
 * (/api/guidance/workflow). Asking the same question twice returns the demo
 * made the first time, with no LLM call.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / bad question / unknown repoKey / unknown model id /
 *   no guide yet for this model / too many demos
 * - 503 missing LLM configuration
 * - 502 upstream LLM failure, or a question the model could not map to files
 */
export const runtime = "nodejs";

const MAX_QUESTION_CHARS = 300;
const MAX_WORKFLOWS = 30;

interface AskBody {
  repoKey?: unknown;
  question?: unknown;
  model?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: AskBody;
  try {
    body = (await request.json()) as AskBody;
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  const { repoKey } = body;
  if (typeof repoKey !== "string" || repoKey.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: repoKey" }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.replace(/\s+/g, " ").trim() : "";
  if (question.length === 0) {
    return NextResponse.json({ error: "CityCode: type a question first" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `CityCode: keep the question under ${MAX_QUESTION_CHARS} characters` },
      { status: 400 },
    );
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

  const guide = getCachedGuide(repoKey, graph.headSha, modelId) ?? loadSnapshotGuide(repoKey, graph.headSha, modelId);
  if (guide === undefined) {
    return NextResponse.json(
      { error: "CityCode: the guide is not available — close and reopen Repo Guidance first" },
      { status: 400 },
    );
  }

  const same = guide.workflows.find((w) => w.question?.toLowerCase() === question.toLowerCase());
  if (same !== undefined) {
    return NextResponse.json({ workflow: same, existing: true }, { status: 200 });
  }
  if (guide.workflows.length >= MAX_WORKFLOWS) {
    return NextResponse.json(
      { error: `CityCode: the guide already has ${MAX_WORKFLOWS} demos — that is the limit` },
      { status: 400 },
    );
  }

  try {
    getLlmClient(modelId);
    const { workflow } = await designWorkflow(
      graph,
      question,
      guide.workflows.map((w) => w.id),
      modelId,
    );
    // The guide may have been replaced while the model was thinking; append
    // to whatever is current rather than to the copy read above. The model
    // stamp rides along, so the snapshot stays per-model consistent.
    const current = getCachedGuide(repoKey, graph.headSha, modelId) ?? guide;
    const updated = { ...current, workflows: [...current.workflows, workflow] };
    rememberGuide(repoKey, graph.headSha, updated);
    updateSnapshot(repoKey, graph.headSha, (snapshot) => {
      snapshot.repoGuides = { ...(snapshot.repoGuides ?? {}), [guideModelId(updated)]: updated };
      snapshot.repoGuide = updated;
    });
    return NextResponse.json({ workflow, existing: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: could not create that demo";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
