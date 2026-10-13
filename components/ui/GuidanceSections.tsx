"use client";

/**
 * GuidanceSections — the presentational pieces of the Repo Guidance modal:
 * the model picker (the layer shown before a guide is generated), workflow
 * cards (the "what can you do" options), feature list, reading path. No
 * data fetching here; GuidanceModal owns that and passes handlers.
 */

import { useState, type FormEvent } from "react";

import type { GuideFeature, ReadingStop, WorkflowSummary } from "@/lib/guidance/types";
import type { LlmModelInfo } from "@/lib/llm/models";

export function baseName(fileId: string): string {
  return fileId.slice(fileId.lastIndexOf("/") + 1);
}

export function SectionTitle({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h3 className="eyebrow">{children}</h3>
      {hint !== undefined ? <p className="text-[11px] text-[var(--ink-secondary)]">{hint}</p> : null}
    </div>
  );
}

/**
 * The model-selection layer shown before a guide is generated: one card per
 * registry model. Fully controlled — `selected` (the last pick, defaulting
 * to the registry default) and `onSelect` come from the modal, which stores
 * them; confirming hands the chosen model id to `onConfirm`. `busy` covers
 * the in-flight generation; `regenerate` swaps the copy and button label
 * when a guide is already on screen.
 */
export function ModelPicker({
  models,
  selected,
  onSelect,
  busy,
  error,
  regenerate,
  onConfirm,
  onCancel,
}: {
  models: readonly LlmModelInfo[];
  selected: string;
  onSelect: (modelId: string) => void;
  busy: boolean;
  error: string | null;
  regenerate: boolean;
  onConfirm: (modelId: string) => void;
  onCancel?: () => void;
}) {
  const selectedInfo = models.find((model) => model.id === selected);
  const confirmLabel = `${regenerate ? "Regenerate" : "Generate"} with ${selectedInfo?.label ?? selected}`;

  return (
    <section className="space-y-3" aria-live="polite">
      <div>
        <SectionTitle hint="Used for this repo's guided demos, reading path, and ask-a-question answers">
          Choose a model
        </SectionTitle>
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
          {regenerate
            ? "Each model keeps its own guide for this repo state — regenerating drafts a fresh one for your pick."
            : "The model that reads this repo and drafts your guide. You can switch later; each model keeps its own copy."}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Guidance model">
        {models.map((model) => (
          <button
            key={model.id}
            type="button"
            disabled={busy}
            aria-pressed={selected === model.id}
            onClick={() => onSelect(model.id)}
            className={`focus-ring flex w-full flex-col gap-1 rounded-xl border bg-[var(--surface)] p-3 text-left shadow-[var(--pill-shadow)] transition-all hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 ${
              selected === model.id ? "border-[#5B5BD6] shadow-md" : "border-[var(--border)]"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-[var(--ink)]">{model.label}</span>
              <span className="rounded-full border border-[var(--border)] px-1.5 py-px font-mono text-[9px] text-[var(--ink-secondary)]">
                {model.provider}
              </span>
            </span>
            <span className="text-[11px] leading-snug text-[var(--ink-secondary)]">{model.blurb}</span>
          </button>
        ))}
      </div>

      {busy ? (
        <p className="flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
          <Spinner />
          {selectedInfo?.label ?? "The model"} is reading the repo — the first run can take up to a minute.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs leading-relaxed text-[#C05B4A]">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {onCancel !== undefined ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="focus-ring text-xs text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink)] disabled:opacity-60"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onConfirm(selected)}
          disabled={busy}
          className="pill-button focus-ring inline-flex items-center gap-1.5 text-xs"
        >
          {busy ? <Spinner /> : null}
          {confirmLabel}
        </button>
      </div>
    </section>
  );
}

/** A file reference: click to close the guide and fly the camera to its building. */
export function FileChip({ fileId, onShow }: { fileId: string; onShow: (fileId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onShow(fileId)}
      title={`${fileId} — show in the city`}
      className="focus-ring inline-block max-w-full truncate rounded-md border border-[var(--border)] bg-[var(--paper)] px-1.5 py-0.5 align-middle font-mono text-[11px] text-[var(--ink)] transition-colors hover:border-[#5B5BD6] hover:bg-white"
    >
      {baseName(fileId)}
    </button>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  );
}

/** `a.ts → b.ts → c.ts +2` — the shape of a workflow at a glance. */
function RouteChain({ route }: { route: WorkflowSummary["route"] }) {
  const names = route.map((stop) => baseName(stop.fileId));
  const shown = names.slice(0, 4);
  const more = names.length - shown.length;
  return (
    <span className="block truncate font-mono text-[10.5px] text-[var(--ink-secondary)]">
      {shown.join(" → ")}
      {more > 0 ? ` → … +${more}` : ""}
    </span>
  );
}

export function WorkflowCard({
  workflow,
  loading,
  disabled,
  error,
  onPlay,
}: {
  workflow: WorkflowSummary;
  /** This card's workflow is being traced right now. */
  loading: boolean;
  /** Another card is busy — block double starts. */
  disabled: boolean;
  error: string | null;
  onPlay: (workflow: WorkflowSummary) => void;
}) {
  return (
    <li className="flex">
      <button
        type="button"
        onClick={() => onPlay(workflow)}
        disabled={disabled || loading}
        aria-busy={loading}
        className="focus-ring group flex w-full flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left shadow-[var(--pill-shadow)] transition-all hover:-translate-y-px hover:border-[#5B5BD6] hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="text-[13px] font-semibold leading-snug text-[var(--ink)]">{workflow.title}</span>
          <span
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#5B5BD6] text-white"
            aria-hidden="true"
          >
            {loading ? <Spinner /> : <PlayIcon />}
          </span>
        </span>
        <span className="text-xs leading-relaxed text-[var(--ink-secondary)]">{workflow.goal}</span>
        {workflow.question !== undefined ? (
          <span className="text-[11px] italic leading-snug text-[#5B5BD6]">Your question: “{workflow.question}”</span>
        ) : null}
        {workflow.trigger.length > 0 ? (
          <span className="text-[11px] leading-snug text-[var(--ink-secondary)]">
            <span className="font-medium text-[var(--ink)]">Starts when:</span> {workflow.trigger}
          </span>
        ) : null}
        <RouteChain route={workflow.route} />
        {loading ? (
          <span className="text-[11px] font-medium text-[#5B5BD6]">
            Tracing the real code… the first run takes a little while, then it is saved.
          </span>
        ) : null}
        {error !== null ? (
          <span role="alert" className="text-[11px] leading-snug text-[#C05B4A]">
            {error}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * Ask-your-own-question box: the answer becomes a new guided demo in the
 * list. `onAsk` resolves true on success (the box then clears itself).
 */
export function AskBox({
  busy,
  error,
  onAsk,
}: {
  busy: boolean;
  error: string | null;
  onAsk: (question: string) => Promise<boolean>;
}) {
  const [question, setQuestion] = useState("");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = question.trim();
    if (text.length === 0 || busy) return;
    if (await onAsk(text)) setQuestion("");
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="mt-3 rounded-xl border border-dashed border-[var(--border)] p-3">
      <label htmlFor="guidance-ask" className="text-xs font-medium text-[var(--ink)]">
        Not seeing what you want to know? Ask how something works:
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="guidance-ask"
          type="text"
          value={question}
          maxLength={300}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="e.g. How does a GitHub URL end up as buildings?"
          className="focus-ring min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-secondary)] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || question.trim().length === 0}
          className="pill-button focus-ring inline-flex shrink-0 items-center gap-1.5 text-xs"
        >
          {busy ? <Spinner /> : null}
          {busy ? "Designing…" : "Create demo"}
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="mt-1.5 text-[11px] leading-snug text-[#C05B4A]">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function FeatureList({
  features,
  onShowFile,
}: {
  features: GuideFeature[];
  onShowFile: (fileId: string) => void;
}) {
  return (
    <ul className="space-y-3">
      {features.map((feature) => (
        <li key={feature.title}>
          <p className="text-[13px] font-semibold text-[var(--ink)]">{feature.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-secondary)]">{feature.summary}</p>
          {feature.files.length > 0 ? (
            <p className="mt-1.5 flex flex-wrap gap-1">
              {feature.files.map((fileId) => (
                <FileChip key={fileId} fileId={fileId} onShow={onShowFile} />
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ReadingPathList({
  stops,
  onShowFile,
  onStartTour,
}: {
  stops: ReadingStop[];
  onShowFile: (fileId: string) => void;
  onStartTour: () => void;
}) {
  return (
    <div>
      <ol className="space-y-2">
        {stops.map((stop, i) => (
          <li key={stop.fileId} className="flex items-start gap-2.5">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--paper)] font-mono text-[10px] text-[var(--ink-secondary)]">
              {i + 1}
            </span>
            <div className="min-w-0">
              <FileChip fileId={stop.fileId} onShow={onShowFile} />
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-secondary)]">{stop.why}</p>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={onStartTour}
        className="pill-button focus-ring mt-3 inline-flex items-center gap-1.5 text-xs"
      >
        <PlayIcon />
        Start the tour
      </button>
    </div>
  );
}
