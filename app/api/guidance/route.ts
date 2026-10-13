import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { DEFAULT_LLM_MODEL, LLM_MODELS, ensureGuideModel, guideModelId, normalizeLlmModelId } from "@/lib/llm/models";
import { getCachedGuide, getStoredGraph, rememberGuide } from "@/lib/llm/graphCache";
import { generateRepoGuide } from "@/lib/llm/guidePrompts";
import { selectKeyFiles } from "@/lib/llm/keyFiles";
import { loadSnapshot, loadSnapshotGuide } from "@/lib/snapshot/load";
import type { RepoGuide } from "@/lib/guidance/types";
import { updateSnapshot } from "@/lib/snapshot/save";

/**
 * POST /api/guidance — the repo-wide structured guide (phase A).
 *
 * Body: { repoKey, model?, probe? }. The graph must have been produced by
 * /api/analyze on this server run (in-memory graph store). The guide —
 * identity, workflow options, features, reading path, data flow — is
 * generated at most once per (ingested repo state, MODEL): Repo Guidance
 * lets the user pick the model per session, and each model keeps its own
 * guide. Tiers: the warm in-memory cache, the persisted snapshot
 * (`repoGuides`, plus the legacy single `repoGuide` slot for guides made
 * before per-model selection), then the LLM call (key-file selection +
 * chat call, grounded against the graph) whose result is cached and written
 * back into the snapshot — so reopening the same repo state with the same
 * model never re-calls the model. With `probe: true` the route ONLY reports
 * the cache tiers (never generates, never 503s on a missing key): it
 * returns `{ cached: false }` or `{ cached: true, guide }` for whichever
 * guide already exists. Workflow demos are traced lazily by
 * /api/guidance/workflow.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey / unknown model id
 * - 503 missing LLM configuration for the requested model's provider
 *   (city stays usable; UI banner)
 * - 502 upstream LLM failure, or a reply with nothing usable in it
 */
export const runtime = "nodejs";

interface GuidanceBody {
  repoKey?: unknown;
  model?: unknown;
  probe?: unknown;
}

/**
 * The probe (model-agnostic "is any guide already here?"): warm caches for
 * every registry model, then the snapshot's per-model slots, then the
 * legacy single slot (which belongs to the default model). The returned
 * guide is stamped, so the client knows which model produced it.
 */
function findExistingGuide(repoKey: string, headSha: string | undefined): RepoGuide | undefined {
  for (const model of LLM_MODELS) {
    const warm = getCachedGuide(repoKey, headSha, model.id);
    if (warm !== undefined) return ensureGuideModel(warm);
  }
  const snapshot = loadSnapshot(repoKey, headSha);
  for (const model of LLM_MODELS) {
    const perModel = snapshot?.repoGuides?.[model.id];
    if (perModel !== undefined) return ensureGuideModel(perModel);
  }
  const legacy = snapshot?.repoGuide;
  if (legacy !== undefined && guideModelId(legacy) === DEFAULT_LLM_MODEL) return ensureGuideModel(legacy);
  return undefined;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: GuidanceBody;
  try {
    body = (await request.json()) as GuidanceBody;
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  const { repoKey } = body;
  if (typeof repoKey !== "string" || repoKey.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: repoKey" }, { status: 400 });
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

  const cachedGuide = getCachedGuide(repoKey, graph.headSha, modelId);
  if (cachedGuide !== undefined) {
    return NextResponse.json({ guide: ensureGuideModel(cachedGuide), cached: true }, { status: 200 });
  }

  // Persisted tier: a guide from a previous server run. (Missing/corrupt
  // snapshot, or a malformed guide inside one → undefined → normal LLM path.
  // A guide from ANOTHER model is a miss too — this model generates its own.)
  const persisted = loadSnapshotGuide(repoKey, graph.headSha, modelId);
  if (persisted !== undefined) {
    rememberGuide(repoKey, graph.headSha, persisted);
    return NextResponse.json({ guide: persisted, cached: true }, { status: 200 });
  }

  // Cache-only probe: nothing left to generate against, so answer honestly
  // and let the client show its model picker.
  if (body.probe === true) {
    const existing = findExistingGuide(repoKey, graph.headSha);
    return NextResponse.json(
      existing === undefined ? { cached: false } : { guide: existing, cached: true },
      { status: 200 },
    );
  }

  try {
    // Config check for the REQUESTED model's provider; a missing key aborts
    // with its readable LlmConfigError message (503, degrades — no crash).
    getLlmClient(modelId);
    const keyFiles = await selectKeyFiles(graph);
    const { guide } = await generateRepoGuide(graph, keyFiles, modelId);
    rememberGuide(repoKey, graph.headSha, guide);
    // Persist (best-effort, atomic — see save.ts). updateSnapshot re-reads the
    // file, so explanations saved during the minute the model spent thinking
    // are not overwritten. The guide goes into its model's slot (leaving any
    // other model's guide intact); the legacy slot mirrors the newest guide.
    // Traced workflows belong to the previous guide's workflow ids, and their
    // snapshot copies are dropped either way — they re-trace lazily.
    updateSnapshot(repoKey, graph.headSha, (snapshot) => {
      snapshot.repoGuides = { ...(snapshot.repoGuides ?? {}), [modelId]: guide };
      snapshot.repoGuide = guide;
      delete snapshot.workflowDetails;
    });
    return NextResponse.json({ guide, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: repo guidance failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
