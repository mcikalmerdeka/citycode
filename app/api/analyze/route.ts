import { NextResponse } from "next/server";
import { computeCityLayout, type CityLayout } from "@/lib/city/layout";
import { cloneRepo } from "@/lib/git/clone";
import { diffCommits, type CommitDiff } from "@/lib/git/diff";
import { parseGitHubUrl } from "@/lib/git/url";
import { applyCommitDiff, type ChangeSet } from "@/lib/diff/apply";
import { buildGraph, type BuildGraphResult } from "@/lib/parser/buildGraph";
import { computeRepoKey } from "@/lib/repoKey";
import { storeGraph, storeAnalysis, getStoredAnalysis, storeCommitDiff } from "@/lib/llm/graphCache";

/**
 * POST /api/analyze — the single ingestion entry point: local folder or
 * GitHub URL → graph → city layout. The renderer (components/city/) only
 * ever consumes the { graph, layout } pair this route returns, so layout
 * happens once server-side and is never re-derived client-side
 * (determinism contract). A successful response also stores the analysis
 * server-side (keyed by repoKey) and reports the key back.
 *
 * Phase 4 adds `mode`:
 * - "static" (default) — the plain render, unchanged shape.
 * - "prev" — the HEAD vs. HEAD~1 compare. When a `repoKey` of this server
 *   run is passed, the stored graph + layout are reused verbatim (zero
 *   layout shift, no re-parse) and only the commit diff is computed; the
 *   response carries the same { graph, layout } plus `changeSet`. Without a
 *   usable repoKey it falls back to a fresh build and compare-closes anyway.
 * - "workdir" — Phase 5; rejected with a readable message for now.
 *
 * Every failure here is a user-input problem — bad JSON, wrong source field,
 * missing path, unreadable folder, bad GitHub URL, clone failure, empty
 * repo, single-commit repo — so everything maps to 400 with the error text;
 * nothing may bubble into a 500.
 */
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "CityCode: request body must be valid JSON" }, { status: 400 });
  }

  if (body === null || typeof body !== "object") {
    return NextResponse.json(
      { error: "CityCode: request body must be a JSON object" },
      { status: 400 },
    );
  }

  // Hand-rolled validation — no zod, no new dependencies (Phase 2 rule).
  const { source, path, repoUrl, mode, repoKey } = body as {
    source?: unknown;
    path?: unknown;
    repoUrl?: unknown;
    mode?: unknown;
    repoKey?: unknown;
  };

  if (mode !== undefined && mode !== "static" && mode !== "prev" && mode !== "workdir") {
    return NextResponse.json(
      { error: 'CityCode: unsupported mode — expected "static", "prev" or "workdir"' },
      { status: 400 },
    );
  }
  if (mode === "workdir") {
    return NextResponse.json(
      {
        error:
          "CityCode: working-directory compare (about to commit) is not available yet — it arrives with the next phase.",
      },
      { status: 400 },
    );
  }

  const compare = mode === "prev";

  // Compare mode with a warm cache: reuse the exact stored analysis so the
  // layout sent back is the very same JSON the static view already rendered.
  if (compare && typeof repoKey === "string") {
    const reused = getStoredAnalysis(repoKey);
    if (reused !== undefined) {
      try {
        const diff = await diffCommits(reused.graph.repoPath);
        const changeSet = applyCommitDiff(reused.graph, diff);
        storeCommitDiff(repoKey, diff);
        return NextResponse.json(
          { graph: reused.graph, layout: reused.layout, warnings: reused.warnings, repoKey, changeSet },
          { status: 200 },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "CityCode: commit diff failed";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }
  }

  try {
    // A cold compare still goes through the full pipeline and then diffs.
    const built = await ingestAndBuild({ source, path, repoUrl });
    const key = computeRepoKey(built.graph);
    storeGraph(built.graph);
    storeAnalysis({ graph: built.graph, layout: built.layout, warnings: built.warnings });

    let changeSet: ChangeSet | undefined;
    let diff: CommitDiff | undefined;
    if (compare) {
      diff = await diffCommits(built.graph.repoPath);
      changeSet = applyCommitDiff(built.graph, diff);
      storeCommitDiff(key, diff);
    }

    return NextResponse.json(
      { graph: built.graph, layout: built.layout, warnings: built.warnings, repoKey: key, changeSet },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: analysis failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Clone/walk → graph → layout. Local path or GitHub URL; throws readable Errors. */
async function ingestAndBuild(request: {
  source?: unknown;
  path?: unknown;
  repoUrl?: unknown;
}): Promise<{ graph: BuildGraphResult["graph"]; layout: CityLayout; warnings: BuildGraphResult["warnings"] }> {
  const { source, path, repoUrl } = request;

  if (source === "local") {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new Error("CityCode: missing required field: path");
    }
    const { graph, warnings } = await buildGraph(path.trim());
    return { graph, layout: computeCityLayout(graph), warnings };
  }

  if (source === "github") {
    const parsed =
      typeof repoUrl === "string" && repoUrl.trim().length > 0 ? parseGitHubUrl(repoUrl) : null;
    if (parsed === null) {
      throw new Error(
        "CityCode: the URL must be an https GitHub repo URL, e.g. https://github.com/<owner>/<repo>",
      );
    }
    const clonePath = await cloneRepo(parsed);
    const { graph, warnings } = await buildGraph(clonePath, "github");
    return { graph, layout: computeCityLayout(graph), warnings };
  }

  throw new Error('CityCode: unsupported source — expected "local" or "github"');
}
