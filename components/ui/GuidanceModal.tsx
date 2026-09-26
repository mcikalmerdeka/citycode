"use client";

/**
 * GuidanceModal — the repo guidance overlay. One LLM guide per analyzed
 * repo state: the query fires only while the modal is open and is cached
 * at three levels (TanStack Query, in-memory graphCache, snapshot), so
 * open/close/reopen is free after the first generation.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

interface GuidanceResponse {
  guide: string;
  cached: boolean;
}

function isGuidanceResponse(value: unknown): value is GuidanceResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { guide?: unknown }).guide === "string" &&
    typeof (value as { cached?: unknown }).cached === "boolean"
  );
}

async function fetchRepoGuidance(repoKey: string): Promise<GuidanceResponse> {
  const response = await fetch("/api/guidance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isGuidanceResponse(body)) {
    return body;
  }
  if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
    throw new Error((body as { error: string }).error);
  }
  throw new Error(`Repo guidance request failed (${response.status})`);
}

export function GuidanceModal({
  repoKey,
  open,
  onClose,
}: {
  repoKey: string;
  open: boolean;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["guidance", repoKey],
    queryFn: () => fetchRepoGuidance(repoKey),
    staleTime: Infinity, // same session + same repo + same state → reuse
    retry: false,
    enabled: open && repoKey.length > 0,
  });

  // Esc closes; the listener exists only while the modal is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(32,33,35,0.35)] backdrop-blur-sm"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="How to navigate this repo"
        className="panel mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
          <h2 className="eyebrow flex items-center gap-2">
            How to navigate this repo
            {query.data?.cached ? (
              <span className="rounded-full border border-[var(--border)] px-1.5 py-px font-mono text-[9px] normal-case tracking-normal text-[var(--ink-secondary)]">
                cached
              </span>
            ) : null}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close repo guidance"
            className="focus-ring rounded-full p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {query.isPending ? (
            <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
              thinking… the first run generates a guide for the whole repo and may take up to a
              minute — reopening it afterwards is instant.
            </p>
          ) : query.isError ? (
            <p role="alert" className="text-xs leading-relaxed text-[#C05B4A]">
              {query.error.message}
            </p>
          ) : query.data ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--ink)]">
              {query.data.guide}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
