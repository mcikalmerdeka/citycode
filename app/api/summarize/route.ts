import { NextResponse } from "next/server";
import { LlmConfigError, getLlmClient } from "@/lib/llm/client";
import {
  getStoredCommitDiff,
  getStoredWorkdirDiff,
  getCompareSummary,
  rememberCompareSummary,
} from "@/lib/llm/graphCache";
import { summarizeDiff } from "@/lib/llm/prompts";

/**
 * POST /api/summarize — the one LLM call per compare view (Phases 4/5).
 *
 * Body: { repoKey, mode? }. Reads the diff that /api/analyze stored for this
 * repoKey — the commit diff for mode "prev" (default) or the unified
 * working-directory change set for mode "workdir" — and turns it into a
 * plain-English paragraph. Summaries are cached per (repoKey, state hash):
 * the commit sha for "prev", the workdirHash for "workdir", so re-toggling
 * compare mode is ever one LLM call per compared state.
 *
 * Failure mapping (never a plain 500):
 * - 400 malformed body / unknown repoKey / no compare run in this session
 * - 503 missing LLM configuration (compare visuals still fully work)
 * - 502 upstream LLM failure
 */
export const runtime = "nodejs";

interface SummarizeBody {
  repoKey?: unknown;
  mode?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: SummarizeBody;
  try {
    body = (await request.json()) as SummarizeBody;
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  const { repoKey, mode } = body;
  if (typeof repoKey !== "string" || repoKey.length === 0) {
    return NextResponse.json({ error: "CityCode: missing field: repoKey" }, { status: 400 });
  }
  if (mode !== undefined && mode !== "prev" && mode !== "workdir") {
    return NextResponse.json(
      { error: 'CityCode: unsupported mode — expected "prev" or "workdir"' },
      { status: 400 },
    );
  }

  if (mode === "workdir") {
    return summarizeWorkdir(repoKey);
  }
  return summarizeCommit(repoKey);
}

/** The prev-compare summary: commit diff → paragraph, cached per headSha. */
async function summarizeCommit(repoKey: string): Promise<NextResponse> {
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

  return generate(repoKey, diff.headSha, () => summarizeDiff(diff.files));
}

/** The workdir-compare summary: unified change set → paragraph, cached per workdirHash. */
async function summarizeWorkdir(repoKey: string): Promise<NextResponse> {
  const diff = getStoredWorkdirDiff(repoKey);
  if (diff === undefined) {
    return NextResponse.json(
      { error: "CityCode: no working-directory diff captured for this repoKey — run an about-to-commit compare first" },
      { status: 400 },
    );
  }

  const cached = getCompareSummary(repoKey, diff.workdirHash);
  if (cached !== undefined) {
    return NextResponse.json({ summary: cached, cached: true }, { status: 200 });
  }

  if (diff.files.length === 0) {
    const emptySummary = "The working directory is clean — nothing is about to be committed.";
    rememberCompareSummary(repoKey, diff.workdirHash, emptySummary);
    return NextResponse.json({ summary: emptySummary, cached: false }, { status: 200 });
  }

  return generate(repoKey, diff.workdirHash, () => summarizeDiff(diff.files));
}

/** Shared tail: config check → LLM call → cache recency — 503/502 mapping. */
async function generate(
  repoKey: string,
  cacheSha: string | undefined,
  summarize: () => Promise<{ summary: string }>,
): Promise<NextResponse> {
  try {
    // Config check happens via the shared client; a missing key aborts with
    // its readable LlmConfigError message (503, degrades — no crash).
    getLlmClient();
    const { summary } = await summarize();
    rememberCompareSummary(repoKey, cacheSha, summary);
    return NextResponse.json({ summary, cached: false }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: change summary failed";
    const status = error instanceof LlmConfigError ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
