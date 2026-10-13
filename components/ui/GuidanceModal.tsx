"use client";

/**
 * GuidanceModal — the Repo Guidance overlay.
 *
 * Opening it first probes the server cache-only. If a guide already exists
 * for the current repo state (whichever model produced it), the modal opens
 * straight to it, with a chip naming its model — click the chip to
 * regenerate with the other one. If nothing is cached, the model picker
 * shows: choosing a model generates the guide (one LLM call per
 * repo-state + model, cached in memory and the snapshot, so reopening is
 * free). The guide leads with the interactive part: workflow cards ("what
 * can you do with this app"). Picking one traces it through the real code
 * (a second, lazy call that is also cached per model) and then closes the
 * modal and starts the guided demo in the city. File chips fly the camera
 * to a building; the reading path can be walked as a tour with the same
 * player. Ask-a-question demos join the session's guide.
 *
 * The per-building "What does this file do?" panel (ExplainPanel) is a
 * different feature and always uses the default model — this modal's
 * choices do not affect it.
 *
 * State model: the modal is remounted per repo (the parent passes
 * `key={repoKey}`), so all session state lives in plain useState and is
 * written only from event callbacks; the shown guide SYNC-DERIVES from the
 * probe result until a generation lands — no effects touch state.
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
import { DEFAULT_LLM_MODEL, guideModelId, findLlmModel, LLM_MODELS } from "@/lib/llm/models";
import { useCityStore } from "@/lib/store";

import {
  AskBox,
  FeatureList,
  ModelPicker,
  ReadingPathList,
  SectionTitle,
  WorkflowCard,
  baseName,
} from "./GuidanceSections";

interface GuideResponse {
  guide: RepoGuide;
  cached: boolean;
}

type ProbeResult = { cached: boolean; guide?: RepoGuide };

/** A guide this client generated (or appended to) during this session. */
interface GeneratedGuide {
  model: string;
  guide: RepoGuide;
  cached: boolean;
}

/** localStorage preference for the picker's preselection (best-effort, client-only). */
const LAST_MODEL_KEY = "citycode.guidanceModel";

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

/** Cache-only probe: never generates, never 503s — it only reports whether a guide exists. */
async function probeGuide(repoKey: string): Promise<ProbeResult> {
  const body = await postForData("/api/guidance", { repoKey, probe: true }, "Repo guidance request failed");
  if (isRecord(body) && typeof body.cached === "boolean") {
    if (body.cached === false) return { cached: false };
    if (isRepoGuide(body.guide)) return { cached: true, guide: body.guide };
  }
  throw new Error("Repo guidance returned an unexpected response");
}

async function fetchGuide(repoKey: string, modelId: string): Promise<GuideResponse> {
  const body = await postForData("/api/guidance", { repoKey, model: modelId }, "Repo guidance request failed");
  if (isRecord(body) && isRepoGuide(body.guide) && typeof body.cached === "boolean") {
    return { guide: body.guide, cached: body.cached };
  }
  throw new Error("Repo guidance returned an unexpected response");
}

async function fetchWorkflow(repoKey: string, workflowId: string, model: string): Promise<WorkflowDetail> {
  const body = await postForData("/api/guidance/workflow", { repoKey, workflowId, model }, "Workflow trace failed");
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

  const probe = useQuery({
    queryKey: ["guide-probe", repoKey],
    queryFn: () => probeGuide(repoKey),
    staleTime: Infinity, // same session + same repo → the checkpoint never regresses
    retry: false,
    enabled: open && repoKey.length > 0,
  });

  const [generating, setGenerating] = useState(false);
  const [pickerMode, setPickerMode] = useState<"switch" | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Preselection for the picker — the last model picked (best-effort stored).
  // Lazy + SSR-guarded: the modal's first (server) render shows nothing anyway.
  const [lastModel, setLastModel] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_LLM_MODEL;
    const stored = window.localStorage.getItem(LAST_MODEL_KEY);
    return stored !== null && findLlmModel(stored) !== undefined ? stored : DEFAULT_LLM_MODEL;
  });

  /** What this session generated; falls back to the probe until then. */
  const [generated, setGenerated] = useState<GeneratedGuide | null>(null);
  const probeGuideValue =
    probe.data !== undefined && probe.data.cached === true && probe.data.guide !== undefined
      ? probe.data.guide
      : undefined;
  const guide = generated?.guide ?? probeGuideValue;
  const sessionModel = generated?.model ?? (probeGuideValue !== undefined ? guideModelId(probeGuideValue) : undefined);
  const sessionCached = generated?.cached ?? probeGuideValue !== undefined;

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
    (tourGuide: RepoGuide) => {
      close();
      useCityStore.getState().select(null);
      useFlowStore.getState().start({
        kind: "tour",
        title: "Reading path",
        subtitle: "The files to read first, in order",
        steps: tourGuide.readingPath.map((stop) => ({
          fileId: stop.fileId,
          title: baseName(stop.fileId),
          narration: stop.why,
        })),
      });
    },
    [close],
  );

  /** Create (or re-create with another model) the guide for this repo state. */
  const generate = useCallback(
    async (modelId: string): Promise<void> => {
      const token = ++run.current;
      setGenerating(true);
      setPickerError(null);
      try {
        const result = await fetchGuide(repoKey, modelId);
        if (run.current !== token) return; // closed or switched repo while generating
        setGenerated({ model: modelId, guide: result.guide, cached: result.cached });
        setPickerMode(null);
        try {
          window.localStorage.setItem(LAST_MODEL_KEY, modelId);
        } catch {
          // Preference persistence is best-effort (quota / privacy modes).
        }
      } catch (error) {
        if (run.current === token) {
          setPickerError(error instanceof Error ? error.message : "Could not generate the repo guidance");
        }
      } finally {
        if (run.current === token) setGenerating(false);
      }
    },
    [repoKey],
  );

  const playWorkflow = async (workflow: WorkflowSummary): Promise<void> => {
    const model = sessionModel;
    if (loadingId !== null || model === undefined) return;
    const token = ++run.current;
    setLoadingId(workflow.id);
    setFailure(null);
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ["workflow", repoKey, model, workflow.id],
        queryFn: () => fetchWorkflow(repoKey, workflow.id, model),
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

  /** Create a custom demo from a question and add it to the session guide. */
  const askQuestion = async (question: string): Promise<boolean> => {
    const model = sessionModel;
    if (model === undefined) return false;
    setAsking(true);
    setAskError(null);
    try {
      const body = await postForData("/api/guidance/ask", { repoKey, question, model }, "Could not create that demo");
      if (!isRecord(body) || !isWorkflowSummary(body.workflow)) {
        throw new Error("The server returned an unexpected response");
      }
      const workflow = body.workflow;
      setGenerated((current) => {
        const baseModel = current?.model ?? model;
        const baseGuide = current?.guide ?? guide;
        if (baseGuide === undefined) return current; // unreachable from the UI (ask renders only with a guide)
        if (baseGuide.workflows.some((w) => w.id === workflow.id)) return current;
        return {
          model: baseModel,
          cached: current?.cached ?? true,
          guide: { ...baseGuide, workflows: [...baseGuide.workflows, workflow] },
        };
      });
      return true;
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "Could not create that demo");
      return false;
    } finally {
      setAsking(false);
    }
  };

  if (!open) return null;

  // Waiting for the probe (the initial cache-only check).
  const waiting = probe.isPending && !probe.isError;
  // No guide anywhere and the probe said so (or it could not ask) → the picker is the whole layer.
  const probeMiss = probe.isError || (probe.data !== undefined && probe.data.cached === false);
  const pickerOpen = pickerMode === "switch" || (sessionModel === undefined && !waiting && probeMiss);

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
            {sessionModel !== undefined ? (
              <button
                type="button"
                onClick={() => {
                  setPickerMode("switch");
                  setPickerError(null);
                }}
                aria-label="Regenerate the guide with another model"
                className="focus-ring rounded-full border border-[var(--border)] px-1.5 py-px font-mono text-[9px] normal-case tracking-normal text-[var(--ink-secondary)] transition-colors hover:border-[#5B5BD6] hover:bg-white hover:text-[var(--ink)]"
              >
                {findLlmModel(sessionModel)?.label ?? sessionModel}
              </button>
            ) : null}
            {sessionModel !== undefined && sessionCached ? (
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
          {waiting ? (
            <LoadingState />
          ) : pickerOpen ? (
            <ModelPicker
              models={LLM_MODELS}
              selected={lastModel}
              onSelect={setLastModel}
              busy={generating}
              error={pickerError}
              regenerate={sessionModel !== undefined}
              onConfirm={(modelId) => void generate(modelId)}
              onCancel={sessionModel === undefined ? undefined : () => setPickerMode(null)}
            />
          ) : guide !== undefined && sessionModel !== undefined ? (
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
