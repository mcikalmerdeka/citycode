"use client";

/**
 * GuidanceModal — the Repo Guidance overlay.
 *
 * Opening it loads the structured guide (one LLM call per repo state, cached
 * in memory and in the snapshot, so reopening is free). The guide leads with
 * the interactive part: workflow cards ("what can you do with this app").
 * Picking one traces it through the real code (a second, lazy call that is
 * also cached) and then closes the modal and starts the guided demo in the
 * city. File chips fly the camera to a building; the reading path can be
 * walked as a tour with the same player.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useFlowStore } from "@/lib/guidance/flowStore";
import {
  isRepoGuide,
  isWorkflowDetail,
  isWorkflowSummary,
  type RepoGuide,
  type WorkflowDetail,
  type WorkflowSummary,
} from "@/lib/guidance/types";
import { useCityStore } from "@/lib/store";

import {
  AskBox,
  FeatureList,
  ReadingPathList,
  SectionTitle,
  WorkflowCard,
  baseName,
} from "./GuidanceSections";

interface GuideResponse {
  guide: RepoGuide;
  cached: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** POST JSON; throws the route's readable error message on a non-2xx reply. */
async function postForData(url: string, payload: unknown, failure: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body;
  if (isRecord(body) && typeof body.error === "string") throw new Error(body.error);
  throw new Error(`${failure} (${response.status})`);
}

async function fetchGuide(repoKey: string): Promise<GuideResponse> {
  const body = await postForData("/api/guidance", { repoKey }, "Repo guidance request failed");
  if (isRecord(body) && isRepoGuide(body.guide) && typeof body.cached === "boolean") {
    return { guide: body.guide, cached: body.cached };
  }
  throw new Error("Repo guidance returned an unexpected response");
}

async function fetchWorkflow(repoKey: string, workflowId: string): Promise<WorkflowDetail> {
  const body = await postForData("/api/guidance/workflow", { repoKey, workflowId }, "Workflow trace failed");
  if (isRecord(body) && isWorkflowDetail(body.detail)) return body.detail;
  throw new Error("The workflow trace returned an unexpected response");
}

function LoadingState() {
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
        Reading the repo and drafting your guide… the first run can take up to a minute — reopening it
        afterwards is instant.
      </p>
      <div className="space-y-2" aria-hidden="true">
        <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--paper)]" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--paper)]" />
        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="h-20 animate-pulse rounded-xl bg-[var(--paper)]" />
          <div className="h-20 animate-pulse rounded-xl bg-[var(--paper)]" />
        </div>
      </div>
    </div>
  );
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
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["guide", repoKey],
    queryFn: () => fetchGuide(repoKey),
    staleTime: Infinity, // same session + same repo + same state → reuse
    retry: false,
    enabled: open && repoKey.length > 0,
  });

  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  /** Bumped to cancel an in-flight "trace then play" (modal closed, repo changed). */
  const run = useRef(0);

  useEffect(() => {
    run.current += 1;
  }, [repoKey]);

  const close = useCallback(() => {
    run.current += 1;
    setLoadingId(null);
    onClose();
  }, [onClose]);

  // Esc closes; the listener exists only while the modal is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const showFile = useCallback(
    (fileId: string) => {
      close();
      useCityStore.getState().select(fileId);
      useCityStore.getState().requestFocus(fileId);
    },
    [close],
  );

  const startTour = useCallback(
    (guide: RepoGuide) => {
      close();
      useCityStore.getState().select(null);
      useFlowStore.getState().start({
        kind: "tour",
        title: "Reading path",
        subtitle: "The files to read first, in order",
        steps: guide.readingPath.map((stop) => ({
          fileId: stop.fileId,
          title: baseName(stop.fileId),
          narration: stop.why,
        })),
      });
    },
    [close],
  );

  const playWorkflow = async (workflow: WorkflowSummary): Promise<void> => {
    if (loadingId !== null) return;
    const token = ++run.current;
    setLoadingId(workflow.id);
    setFailure(null);
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ["workflow", repoKey, workflow.id],
        queryFn: () => fetchWorkflow(repoKey, workflow.id),
        staleTime: Infinity,
      });
      if (run.current !== token) return; // closed or switched repo while tracing
      useCityStore.getState().select(null);
      useFlowStore.getState().start({
        kind: "flow",
        title: workflow.title,
        subtitle: workflow.goal,
        steps: detail.steps,
      });
      onClose();
    } catch (error) {
      if (run.current === token) {
        setFailure({
          id: workflow.id,
          message: error instanceof Error ? error.message : "Could not trace this workflow",
        });
      }
    } finally {
      if (run.current === token) setLoadingId(null);
    }
  };

  /** Create a custom demo from a question and add it to the guide's list. */
  const askQuestion = async (question: string): Promise<boolean> => {
    setAsking(true);
    setAskError(null);
    try {
      const body = await postForData("/api/guidance/ask", { repoKey, question }, "Could not create that demo");
      if (!isRecord(body) || !isWorkflowSummary(body.workflow)) {
        throw new Error("The server returned an unexpected response");
      }
      const workflow = body.workflow;
      queryClient.setQueryData<GuideResponse>(["guide", repoKey], (old) =>
        old === undefined || old.guide.workflows.some((w) => w.id === workflow.id)
          ? old
          : { ...old, guide: { ...old.guide, workflows: [...old.guide.workflows, workflow] } },
      );
      return true;
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "Could not create that demo");
      return false;
    } finally {
      setAsking(false);
    }
  };

  if (!open) return null;

  const guide = query.data?.guide;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(32,33,35,0.35)] backdrop-blur-sm"
      onClick={close}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="How to navigate this repo"
        className="panel mx-4 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-3">
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
            onClick={close}
            aria-label="Close repo guidance"
            className="focus-ring rounded-full p-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {query.isPending ? (
            <LoadingState />
          ) : query.isError ? (
            <div className="space-y-2">
              <p role="alert" className="text-xs leading-relaxed text-[#C05B4A]">
                {query.error.message}
              </p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="pill-button focus-ring text-xs"
              >
                Try again
              </button>
            </div>
          ) : guide ? (
            <>
              <section>
                <SectionTitle>What this repo is</SectionTitle>
                <p className="text-sm leading-relaxed text-[var(--ink)]">{guide.identity}</p>
              </section>

              <section>
                <SectionTitle hint="Pick one and watch the data move through the code">
                  What you can do — guided demos
                </SectionTitle>
                {guide.workflows.length === 0 ? (
                  <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
                    No traceable workflows were found for this repo — the sections below still apply.
                  </p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {guide.workflows.map((workflow) => (
                      <WorkflowCard
                        key={workflow.id}
                        workflow={workflow}
                        loading={loadingId === workflow.id}
                        disabled={loadingId !== null}
                        error={failure?.id === workflow.id ? failure.message : null}
                        onPlay={(picked) => void playWorkflow(picked)}
                      />
                    ))}
                  </ul>
                )}
                <AskBox busy={asking} error={askError} onAsk={askQuestion} />
              </section>

              {guide.features.length > 0 ? (
                <section>
                  <SectionTitle>Main features</SectionTitle>
                  <FeatureList features={guide.features} onShowFile={showFile} />
                </section>
              ) : null}

              {guide.readingPath.length > 0 ? (
                <section>
                  <SectionTitle hint="Click a file to find it in the city">Ordered reading path</SectionTitle>
                  <ReadingPathList
                    stops={guide.readingPath}
                    onShowFile={showFile}
                    onStartTour={() => startTour(guide)}
                  />
                </section>
              ) : null}

              {guide.dataFlow.length > 0 ? (
                <section>
                  <SectionTitle>Data flow</SectionTitle>
                  <p className="text-sm leading-relaxed text-[var(--ink)]">{guide.dataFlow}</p>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
