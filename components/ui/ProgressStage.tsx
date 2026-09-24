"use client";

/**
 * ProgressStage — Phase 7 pipeline stage feedback: the coarse, honest
 * milestones of an analysis (clone → walk → parse → layout → save),
 * rendered as a single small label inside the import form.
 *
 * Deliberately minimal: a pulsing dot + one line of text, in the form's
 * existing visual language (font-mono microcopy, zinc palette). No
 * percentage bars — the pipeline has no reliable total to scale against,
 * and a fake bar is a worse lie than a real label.
 */

import type { AnalysisStage } from "@/lib/progress";

const STAGE_LABELS: Record<AnalysisStage, string> = {
  cloning: "Cloning repository",
  walking: "Scanning files",
  parsing: "Parsing code",
  layout: "Laying out the city",
  saving: "Saving snapshot",
  "loading-snapshot": "Loading saved city",
};

export interface PipelineStage {
  stage: AnalysisStage;
  detail?: string;
}

export function ProgressStage({ stage }: { stage: PipelineStage | null }) {
  if (stage === null) {
    return null;
  }
  return (
    <div className="flex items-center gap-1.5" aria-live="polite">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400"
      />
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
        {STAGE_LABELS[stage.stage]}
        {stage.detail ? <span className="text-zinc-600"> — {stage.detail}</span> : null}
      </p>
    </div>
  );
}
