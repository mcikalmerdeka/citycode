import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import {
  getStoredCommitDiff,
  getCompareSummary,
  rememberCompareSummary,
} from "@/lib/llm/graphCache";
import { summarizeDiff } from "@/lib/llm/prompts";

/**
 * POST /api/summarize — Phase 4's one LLM call per compare view.
 *
 * Body: { repoKey }. Reads the commit diff that /api/analyze (mode "prev")
 * stored for this repoKey and turns it into a plain-English paragraph.
 * Summaries are cached per (repoKey, headSha) so re-toggling compare mode
 * or re-rendering the same commit is ever one LLM call.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey / no compare run in this session
 * - 503 missing LLM configuration (compare visuals still fully work)
 * - 502 upstream LLM failure
 */
export const runtime = "nodejs";

interface SummarizeBody {
  repoKey?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: SummarizeBody;
  try {
    body = (await request.json()) as SummarizeBody;
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  const { repoKey } = body;
  if (typeof repoKey !== "string" || repoKey.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: repoKey" }, { status: 400 });
  }

  const diff = getStoredCommitDiff(repoKey);
  if (diff === undefined) {
    return NextResponse.json(
      { error: "CityCode: no commit diff captured for this repoKey — run a previous-commit compare first" },
      { status: 400 },
    );
  }

  const cached = getCompareSummary(repoKey, diff.headSha);
  if (cached !== undefined) {
    return NextResponse.json({ summary: cached, cached: true }, { status: 200 });
  }

  if (diff.files.length === 0) {
    const emptySummary = "No files changed between these two commits.";
    rememberCompareSummary(repoKey, diff.headSha, emptySummary);
    return NextResponse.json({ summary: emptySummary, cached: false }, { status: 200 });
  }

  try {
    // Config check happens via the shared client; a missing key aborts with
    // its readable LlmConfigError message (503, degrades — no crash).
    getLlmClient();
    const { summary } = await summarizeDiff(diff.files);
    rememberCompareSummary(repoKey, diff.headSha, summary);
    return NextResponse.json({ summary, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: change summary failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
