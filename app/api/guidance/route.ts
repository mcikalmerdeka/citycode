import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import { getCachedGuidance, getStoredGraph, rememberGuidance } from "@/lib/llm/graphCache";
import { selectKeyFiles } from "@/lib/llm/keyFiles";
import { generateRepoGuidance } from "@/lib/llm/prompts";
import { loadSnapshot } from "@/lib/snapshot/load";
import { saveSnapshot } from "@/lib/snapshot/save";

/**
 * POST /api/guidance — the repo-wide LLM guide.
 *
 * Body: { repoKey }. The graph must have been produced by /api/analyze on
 * this server run (in-memory graph store). The guide is generated at most
 * once per ingested repo state: tier 1 is the warm in-memory cache, tier 2
 * the persisted snapshot (`repoGuidance`), tier 3 the LLM call (key-file
 * selection + chat call) whose result is cached and written back into the
 * snapshot — so reopening the same repo state never re-calls the model.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey
 * - 503 missing LLM configuration (city stays usable; UI banner)
 * - 502 upstream LLM failure
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

  const cachedGuide = getCachedGuidance(repoKey, graph.headSha);
  if (cachedGuide !== undefined) {
    return NextResponse.json({ guide: cachedGuide, cached: true }, { status: 200 });
  }

  // Persisted tier: a guide from a previous server run. (Missing/corrupt
  // snapshot → undefined → normal LLM path; never crashes.)
  const snapshot = loadSnapshot(repoKey, graph.headSha);
  const persisted = snapshot?.repoGuidance;
  if (persisted !== undefined && persisted.length > 0) {
    rememberGuidance(repoKey, graph.headSha, persisted);
    return NextResponse.json({ guide: persisted, cached: true }, { status: 200 });
  }

  try {
    // Config check via the shared client; a missing key aborts with its
    // readable LlmConfigError message (503, degrades — no crash).
    getLlmClient();
    const keyFiles = await selectKeyFiles(graph);
    const { guide } = await generateRepoGuidance(graph, keyFiles);
    rememberGuidance(repoKey, graph.headSha, guide);
    // Persist into the snapshot (best-effort, atomic — see save.ts). One
    // guide per snapshot file; snapshot keys already encode the repo state,
    // so the slot is simply replaced.
    if (snapshot !== undefined) {
      snapshot.repoGuidance = guide;
      saveSnapshot(snapshot, repoKey, graph.headSha);
    }
    return NextResponse.json({ guide, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: repo guidance failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
