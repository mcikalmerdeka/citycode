import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { getCachedGuide, getStoredGraph, rememberGuide } from "@/lib/llm/graphCache";
import { generateRepoGuide } from "@/lib/llm/guidePrompts";
import { selectKeyFiles } from "@/lib/llm/keyFiles";
import { loadSnapshot } from "@/lib/snapshot/load";
import { updateSnapshot } from "@/lib/snapshot/save";

/**
 * POST /api/guidance — the repo-wide structured guide (phase A).
 *
 * Body: { repoKey }. The graph must have been produced by /api/analyze on
 * this server run (in-memory graph store). The guide — identity, workflow
 * options, features, reading path, data flow — is generated at most once per
 * ingested repo state: tier 1 is the warm in-memory cache, tier 2 the
 * persisted snapshot (`repoGuide`), tier 3 the LLM call (key-file selection +
 * chat call, grounded against the graph) whose result is cached and written
 * back into the snapshot — so reopening the same repo state never re-calls
 * the model. Workflow demos are traced lazily by /api/guidance/workflow.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey
 * - 503 missing LLM configuration (city stays usable; UI banner)
 * - 502 upstream LLM failure, or a reply with nothing usable in it
 */
export const runtime = "nodejs";

interface GuidanceBody {
  repoKey?: unknown;
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

  const graph = getStoredGraph(repoKey);
  if (graph === undefined) {
    return NextResponse.json(
      { error: "CityCode: unknown repoKey — analyze the repo in this server session first" },
      { status: 400 },
    );
  }

  const cachedGuide = getCachedGuide(repoKey, graph.headSha);
  if (cachedGuide !== undefined) {
    return NextResponse.json({ guide: cachedGuide, cached: true }, { status: 200 });
  }

  // Persisted tier: a guide from a previous server run. (Missing/corrupt
  // snapshot, or a malformed guide inside one → undefined → normal LLM path.)
  const persisted = loadSnapshot(repoKey, graph.headSha)?.repoGuide;
  if (persisted !== undefined) {
    rememberGuide(repoKey, graph.headSha, persisted);
    return NextResponse.json({ guide: persisted, cached: true }, { status: 200 });
  }

  try {
    // Config check via the shared client; a missing key aborts with its
    // readable LlmConfigError message (503, degrades — no crash).
    getLlmClient();
    const keyFiles = await selectKeyFiles(graph);
    const { guide } = await generateRepoGuide(graph, keyFiles);
    rememberGuide(repoKey, graph.headSha, guide);
    // Persist (best-effort, atomic — see save.ts). updateSnapshot re-reads the
    // file, so explanations saved during the minute the model spent thinking
    // are not overwritten. A new guide replaces any traced workflows, which
    // belong to the previous guide's workflow ids.
    updateSnapshot(repoKey, graph.headSha, (snapshot) => {
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
