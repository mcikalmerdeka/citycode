import { NextResponse } from "next/server";
import { computeCityLayout } from "@/lib/city/layout";
import { cloneRepo } from "@/lib/git/clone";
import { parseGitHubUrl } from "@/lib/git/url";
import { buildGraph } from "@/lib/parser/buildGraph";
import { computeRepoKey } from "@/lib/repoKey";
import { storeGraph } from "@/lib/llm/graphCache";

/**
 * POST /api/analyze — the single ingestion entry point: local folder or
 * GitHub URL → graph → city layout. The renderer (components/city/) only
 * ever consumes the { graph, layout } pair this route returns, so layout
 * happens once server-side and is never re-derived client-side
 * (determinism contract). A successful response also stores the graph
 * server-side (keyed by repoKey) for /api/explain and reports the key back.
 *
 * Every failure here is a user-input problem — bad JSON, wrong source field,
 * missing path, unreadable folder, bad GitHub URL, clone failure, empty
 * repo — so everything maps to 400 with the error text; nothing may bubble
 * into a 500.
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
  const { source, path, repoUrl } = body as { source?: unknown; path?: unknown; repoUrl?: unknown };

  try {
    if (source === "local") {
      if (typeof path !== "string" || path.trim().length === 0) {
        return NextResponse.json({ error: "CityCode: missing required field: path" }, { status: 400 });
      }
      const { graph, warnings } = await buildGraph(path);
      const layout = computeCityLayout(graph);
      const repoKey = computeRepoKey(graph);
      storeGraph(graph);
      return NextResponse.json({ graph, layout, warnings, repoKey }, { status: 200 });
    }

    if (source === "github") {
      const parsed =
        typeof repoUrl === "string" && repoUrl.trim().length > 0 ? parseGitHubUrl(repoUrl) : null;
      if (parsed === null) {
        return NextResponse.json(
          {
            error:
              "CityCode: the URL must be an https GitHub repo URL, e.g. https://github.com/<owner>/<repo>",
          },
          { status: 400 },
        );
      }
      const clonePath = await cloneRepo(parsed);
      const { graph, warnings } = await buildGraph(clonePath, "github");
      const layout = computeCityLayout(graph);
      const repoKey = computeRepoKey(graph);
      storeGraph(graph);
      return NextResponse.json({ graph, layout, warnings, repoKey }, { status: 200 });
    }

    return NextResponse.json(
      { error: 'CityCode: unsupported source — expected "local" or "github"' },
      { status: 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: analysis failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
