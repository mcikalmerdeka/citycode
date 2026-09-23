/**
 * OpenAI LLM client (Phase 3) — the `lib/llm/client.ts` wrapper from the
 * plan. One shared OpenAI SDK instance against the standard OpenAI endpoint,
 * using OPENAI_API_KEY and the gpt-6-luna model (released 2026-09-22) at
 * reasoning effort "medium".
 *
 * Degradation contract: a missing/unusable configuration must never break
 * the city — callers catch {@link LlmConfigError} and surface a clear
 * "explanations disabled" message while everything else keeps working.
 */

import OpenAI from "openai";

/** Thrown when the OPENAI_* env config is missing or malformed. */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** The model CityCode summarizes with (kept in code; key comes from env). */
export const LLM_MODEL = "gpt-6-luna";

/** Reasoning effort applied to every CityCode summarization call. */
export const LLM_REASONING_EFFORT = "medium" as const;

/** Configuration facts read once. `client`/`model` drive every call. */
interface LlmConfig {
  client: OpenAI;
  model: string;
}

function readConfig(): LlmConfig {
  // Env is read lazily (per call-through) instead of at module load so that
  // tests and dev-server reloads always see the current environment.
  const apiKey = process.env.OPENAI_API_KEY;

  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new LlmConfigError(
      "CityCode: OPENAI_API_KEY is not set — LLM explanations are disabled. " +
        "The city still works; set the key in .env to enable explanations.",
    );
  }

  // Standard OpenAI endpoint — no baseURL override is needed.
  const client = new OpenAI({ apiKey });
  return { client, model: LLM_MODEL };
}

/** Module-level singleton — one client instance per server process. */
let cached: LlmConfig | null = null;

/** Shared client accessor. Throws {@link LlmConfigError} when unconfigured. */
export function getLlmClient(): LlmConfig {
  if (cached === null) {
    cached = readConfig();
  }
  return cached;
}

/** Clear the singleton (used by tests). */
export function resetLlmClientCacheForTests(): void {
  cached = null;
}
