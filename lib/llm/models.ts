/**
 * LLM model registry — the pure-data half of the provider layer.
 *
 * One entry per model CityCode can call, each naming its provider and the
 * env key that unlocks it. Imported by BOTH the server (`client.ts` factory)
 * and client components (the Repo Guidance model picker), so it must stay
 * SDK-free: data and pure helpers only.
 *
 * Repo Guidance lets the user pick the model per session; everything else
 * (file explanations, compare summaries) always uses the default. A guide is
 * stamped with the id that produced it (`RepoGuide.model`), so cached
 * guidance can be served per model and legacy guides read as the default.
 */

import type { RepoGuide } from "../guidance/types";

export type LlmProvider = "openai" | "anthropic";

export interface LlmModelInfo {
  /** Canonical id sent to the provider API (and used in cache keys). */
  id: string;
  provider: LlmProvider;
  /** Human name for the picker UI. */
  label: string;
  /** One-line picker description. */
  blurb: string;
  /** Env var that must be set for this model to be usable. */
  envKey: string;
}

export const LLM_MODELS: readonly LlmModelInfo[] = [
  {
    id: "gpt-6-luna",
    provider: "openai",
    label: "GPT-6-Luna",
    blurb: "Current default — medium reasoning effort",
    envKey: "OPENAI_API_KEY",
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    blurb: "Anthropic's fast, cost-efficient model",
    envKey: "ANTHROPIC_API_KEY",
  },
];

/** Model used whenever no explicit choice is made (all non-guidance calls). */
export const DEFAULT_LLM_MODEL = LLM_MODELS[0]!.id;

/** Registry lookup — exact id match only; anything else is a miss. */
export function findLlmModel(id: unknown): LlmModelInfo | undefined {
  if (typeof id !== "string") return undefined;
  return LLM_MODELS.find((model) => model.id === id);
}

/**
 * Resolve a request-supplied model id: `undefined` → default, a registry id
 * → itself, anything else → `null` (the caller turns that into a 400).
 */
export function normalizeLlmModelId(value: unknown): string | null {
  if (value === undefined) return DEFAULT_LLM_MODEL;
  return findLlmModel(value)?.id ?? null;
}

/** Which model produced a guide — unstamped (pre-selection) guides are the default's. */
export function guideModelId(guide: Pick<RepoGuide, "model">): string {
  return guide.model ?? DEFAULT_LLM_MODEL;
}

/** Copy of the guide with a default-model stamp filled in (input never mutated). */
export function ensureGuideModel<T extends Pick<RepoGuide, "model">>(guide: T): T {
  return guide.model === undefined ? { ...guide, model: DEFAULT_LLM_MODEL } : guide;
}
