/**
 * LLM client factory (Phase 3, extended with a second provider) — the
 * `lib/llm/client.ts` wrapper from the plan.
 *
 * `getLlmClient(modelId?)` hands out a provider-neutral {@link ChatClient}
 * for a registry model (see lib/llm/models.ts): the default `gpt-6-luna`
 * over the OpenAI SDK, or `claude-haiku-5-5` over Anthropic's Messages API
 * (via the adapter in anthropicClient.ts). Each model's config is a
 * per-model singleton; a missing env key for the requested provider throws
 * {@link LlmConfigError}.
 *
 * Degradation contract: a missing/unusable configuration must never break
 * the city — callers catch {@link LlmConfigError} and surface a clear
 * "disabled" message while everything else keeps working.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

import type { ChatClient } from "./chat";
import { DEFAULT_LLM_MODEL, findLlmModel, LLM_MODELS, type LlmModelInfo } from "./models";
import { OpenAiChatClient } from "./openAiClient";
import { AnthropicChatClient } from "./anthropicClient";

/** Thrown when the env config for a model's provider is missing/malformed, or the model id is unknown. */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Configuration facts for one model. `client`/`model` drive every call. */
export interface LlmConfig {
  client: ChatClient;
  model: string;
}

function readConfig(info: LlmModelInfo): LlmConfig {
  // Env is read lazily (per call-through) instead of at module load so that
  // tests and dev-server reloads always see the current environment.
  const apiKey = process.env[info.envKey];

  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new LlmConfigError(
      `CityCode: ${info.envKey} is not set — ${info.label} is unavailable. ` +
        "The city still works; set the key in .env to enable this model.",
    );
  }

  const client: ChatClient =
    info.provider === "openai"
      ? new OpenAiChatClient(new OpenAI({ apiKey }).chat.completions)
      : new AnthropicChatClient(new Anthropic({ apiKey }).messages);
  return { client, model: info.id };
}

/** Module-level singletons — one client instance per model per server process. */
const clients = new Map<string, LlmConfig>();

/**
 * Shared client accessor for one registry model (default: gpt-6-luna, which
 * is also what every non-guidance feature uses). Throws {@link LlmConfigError}
 * when the model id is unknown or its provider's env key is missing.
 */
export function getLlmClient(modelId: string = DEFAULT_LLM_MODEL): LlmConfig {
  const info = findLlmModel(modelId);
  if (info === undefined) {
    throw new LlmConfigError(
      `CityCode: unknown LLM model "${modelId}" — available models: ${LLM_MODELS.map((model) => model.id).join(", ")}`,
    );
  }
  let config = clients.get(info.id);
  if (config === undefined) {
    config = readConfig(info);
    clients.set(info.id, config);
  }
  return config;
}

/** Clear the per-model singletons (used by tests). */
export function resetLlmClientCacheForTests(): void {
  clients.clear();
}
