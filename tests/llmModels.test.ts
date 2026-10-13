import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  LLM_MODELS,
  ensureGuideModel,
  findLlmModel,
  guideModelId,
  normalizeLlmModelId,
} from "../lib/llm/models";
import { isRepoGuide, type RepoGuide } from "../lib/guidance/types";

describe("LLM model registry", () => {
  it("offers the default OpenAI model and the Anthropic Haiku model with their env keys", () => {
    const byId = new Map(LLM_MODELS.map((model) => [model.id, model]));
    expect(byId.get("gpt-6-luna")).toMatchObject({
      provider: "openai",
      envKey: "OPENAI_API_KEY",
      label: expect.any(String),
    });
    expect(byId.get("claude-haiku-5-5")).toMatchObject({
      provider: "anthropic",
      envKey: "ANTHROPIC_API_KEY",
      label: expect.any(String),
    });
    expect(DEFAULT_LLM_MODEL).toBe("gpt-6-luna");
  });

  it("findLlmModel matches registry ids exactly and rejects everything else", () => {
    expect(findLlmModel("gpt-6-luna")?.id).toBe("gpt-6-luna");
    expect(findLlmModel("claude-haiku-5-5")?.id).toBe("claude-haiku-5-5");
    expect(findLlmModel("gpt-4")).toBeUndefined();
    expect(findLlmModel("Claude-Haiku-5-5")).toBeUndefined();
    expect(findLlmModel(42)).toBeUndefined();
  });

  it("normalizeLlmModelId maps undefined to the default, valid ids to themselves, junk to null", () => {
    expect(normalizeLlmModelId(undefined)).toBe(DEFAULT_LLM_MODEL);
    expect(normalizeLlmModelId("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(normalizeLlmModelId("nope")).toBeNull();
    expect(normalizeLlmModelId(null)).toBeNull();
    expect(normalizeLlmModelId(7)).toBeNull();
  });
});

describe("guide model stamp", () => {
  const guide: RepoGuide = { identity: "i", workflows: [], features: [], readingPath: [], dataFlow: "" };

  it("a legacy guide without a stamp reads as the default model; a stamped one as its own", () => {
    expect(guideModelId(guide)).toBe(DEFAULT_LLM_MODEL);
    expect(guideModelId({ ...guide, model: "claude-haiku-5-5" })).toBe("claude-haiku-5-5");
  });

  it("ensureGuideModel fills a missing stamp without mutating the input, and keeps existing stamps", () => {
    const filled = ensureGuideModel(guide);
    expect(filled.model).toBe(DEFAULT_LLM_MODEL);
    expect(guide.model).toBeUndefined();
    expect(ensureGuideModel({ ...guide, model: "claude-haiku-5-5" }).model).toBe("claude-haiku-5-5");
  });

  it("isRepoGuide tolerates a string model stamp and rejects a non-string one", () => {
    expect(isRepoGuide(guide)).toBe(true);
    expect(isRepoGuide({ ...guide, model: "claude-haiku-5-5" })).toBe(true);
    expect(isRepoGuide({ ...guide, model: 42 })).toBe(false);
  });
});
