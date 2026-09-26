"use client";

/**
 * ExplainPanel — the Phase 3 click-to-inspect LLM section inside the
 * inspect panel (PRD §7.2). A Summary:query runs automatically whenever
 * `fileId` changes; repeat selections of the same file are served from the
 * server's in-memory cache (shown as "cached") and from TanStack Query's own
 * cache, so a click is at most ever one LLM call.
 *
 * Degradation: with OPENCODE_API_KEY unset the route answers 503 with a
 * readable message rendered here — the rest of the app keeps working.
 */

import { useQuery } from "@tanstack/react-query";

interface ExplainResponse {
  summary: string;
  cached: boolean;
}

function isExplainResponse(value: unknown): value is ExplainResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { summary?: unknown }).summary === "string" &&
    typeof (value as { cached?: unknown }).cached === "boolean"
  );
}

async function fetchExplanation(repoKey: string, fileId: string): Promise<ExplainResponse> {
  const response = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey, fileId }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isExplainResponse(body)) {
    return body;
  }
  if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
    throw new Error((body as { error: string }).error);
  }
  throw new Error(`Explain request failed (${response.status})`);
}

export function ExplainPanel({ repoKey, fileId }: { repoKey: string; fileId: string }) {
  const query = useQuery({
    queryKey: ["explain", repoKey, fileId],
    queryFn: () => fetchExplanation(repoKey, fileId),
    staleTime: Infinity, // same session + same file → reuse without refetch
    retry: false,
  });

  return (
    <section className="mt-4">
      <h3 className="eyebrow flex items-center justify-between">
        What does this file do?
        {query.data?.cached ? (
          <span className="rounded-full border border-[var(--border)] px-1.5 py-px font-mono text-[9px] normal-case tracking-normal text-[var(--ink-secondary)]">
            cached
          </span>
        ) : null}
      </h3>

      {query.isPending ? (
        <p className="mt-1.5 px-1.5 text-[11px] leading-relaxed text-[var(--ink-secondary)]">thinking…</p>
      ) : query.isError ? (
        <p role="alert" className="mt-1.5 px-1.5 text-[11px] leading-relaxed text-[#C05B4A]">
          {query.error.message}
        </p>
      ) : query.data ? (
        <p className="mt-1.5 px-1.5 text-xs leading-relaxed text-[var(--ink)]">{query.data.summary}</p>
      ) : null}
    </section>
  );
}
