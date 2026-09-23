import { NextResponse } from "next/server";
import { computeCityLayout } from "@/lib/city/layout";
import { buildGraph } from "@/lib/parser/buildGraph";

/**
 * POST /api/analyze — Phase 2's single entry point: local folder → graph →
 * city layout. The renderer (components/city/) only ever consumes the
 * { graph, layout } pair this route returns, so layout happens once
 * server-side and is never re-derived client-side (determinism contract).
 *
 * Every failure here is a user-input problem — bad JSON, wrong source field,
 * missing path, unreadable folder, empty repo — so everything maps to 400
 * with the error text; nothing may bubble into a 500.
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
  const { source, path } = body as { source?: unknown; path?: unknown };
  if (source !== "local") {
    return NextResponse.json(
      { error: 'CityCode: unsupported source — expected "local"' },
      { status: 400 },
    );
  }
  if (typeof path !== "string" || path.trim().length === 0) {
    return NextResponse.json({ error: "CityCode: missing required field: path" }, { status: 400 });
  }

  try {
    const { graph, warnings } = await buildGraph(path);
    const layout = computeCityLayout(graph);
    return NextResponse.json({ graph, layout, warnings }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CityCode: analysis failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
