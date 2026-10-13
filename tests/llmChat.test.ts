import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicChatClient } from "../lib/llm/anthropicClient";
import { OpenAiChatClient } from "../lib/llm/openAiClient";
import type { ChatParams } from "../lib/llm/chat";
import { LlmConfigError, getLlmClient, resetLlmClientCacheForTests } from "../lib/llm/client";

/* ------------------------------------------------------------------ *
 * Fakes — the adapters are tested against typed stubs of the SDK
 * surface they consume, not the network.
 * ------------------------------------------------------------------ */

const baseParams: ChatParams = {
  model: "claude-haiku-5-5",
  messages: [
    { role: "system", content: "You ground things." },
    { role: "user", content: "USER PROMPT" },
  ],
  reasoning_effort: "medium",
};

function anthropicMessage(content: Message["content"], stopReason: Message["stop_reason"] = "end_turn"): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    container: null,
    diagnostics: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      service_tier: null,
      server_tool_use: null,
    },
  };
}

function textBlock(text: string): Message["content"][number] {
  return { type: "text", text, citations: null };
}

/* ------------------------------------------------------------------ *
 * Anthropic adapter — Haiku 5.5 request/response contract
 * ------------------------------------------------------------------ */

describe("AnthropicChatClient", () => {
  it("maps system/user messages to the Messages API shape with max_tokens and effort", async () => {
    const create = vi.fn(async (_request: MessageCreateParamsNonStreaming) => {
      void _request; // asserted below via mock.calls
      return anthropicMessage([textBlock("hi")]);
    });
    const client = new AnthropicChatClient({ create });

    const response = await client.chat.completions.create(baseParams);

    expect(create).toHaveBeenCalledOnce();
    const request = create.mock.calls[0]![0];
    expect(request.model).toBe("claude-haiku-5-5");
    expect(request.system).toBe("You ground things.");
    expect(request.messages).toEqual([{ role: "user", content: "USER PROMPT" }]);
    expect(request.max_tokens).toBeGreaterThan(0);
    expect(request.output_config?.effort).toBe("medium");
    // Haiku 5.5 rejects sampling parameters with a 400 — they must stay absent.
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("top_k");
    expect(response.choices[0]?.message?.content).toBe("hi");
  });

  it("reads only the text blocks, in order, and ignores thinking blocks", async () => {
    const create = vi.fn(async () =>
      anthropicMessage([
        { type: "thinking", thinking: "let me think", signature: "sig" },
        textBlock("first "),
        textBlock("second"),
      ]),
    );
    const client = new AnthropicChatClient({ create });
    const response = await client.chat.completions.create(baseParams);
    expect(response.choices[0]?.message?.content).toBe("first second");
  });

  it("throws a readable error when the model refuses", async () => {
    const create = vi.fn(async () => anthropicMessage([textBlock("no")], "refusal"));
    const client = new AnthropicChatClient({ create });
    await expect(client.chat.completions.create(baseParams)).rejects.toThrow(/declined/i);
  });

  it("throws a readable error when output runs out before any text", async () => {
    const create = vi.fn(async () => anthropicMessage([{ type: "thinking", thinking: "…", signature: "s" }], "max_tokens"));
    const client = new AnthropicChatClient({ create });
    await expect(client.chat.completions.create(baseParams)).rejects.toThrow(/token limit/i);
  });
});

/* ------------------------------------------------------------------ *
 * OpenAI adapter — passthrough in the neutral ChatClient shape
 * ------------------------------------------------------------------ */

describe("OpenAiChatClient", () => {
  it("forwards model, messages and reasoning_effort, and extracts the reply text", async () => {
    const completion: ChatCompletion = {
      id: "cmpl_test",
      object: "chat.completion",
      created: 0,
      model: "gpt-6-luna",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "the answer", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    };
    const create = vi.fn(async (_request: ChatCompletionCreateParamsNonStreaming) => {
      void _request; // asserted below via mock.calls
      return completion;
    });
    const client = new OpenAiChatClient({ create });

    const response = await client.chat.completions.create({
      model: "gpt-6-luna",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      reasoning_effort: "medium",
    });

    expect(create.mock.calls[0]![0]).toEqual({
      model: "gpt-6-luna",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      reasoning_effort: "medium",
    });
    expect(response.choices[0]?.message?.content).toBe("the answer");
  });
});

/* ------------------------------------------------------------------ *
 * getLlmClient(modelId) — per-model configuration
 * ------------------------------------------------------------------ */

describe("getLlmClient per model", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    resetLlmClientCacheForTests();
  });

  it("defaults to gpt-6-luna backed by OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "k";
    resetLlmClientCacheForTests();
    const config = getLlmClient();
    expect(config.model).toBe("gpt-6-luna");
    expect(config.client).toBeInstanceOf(OpenAiChatClient);
  });

  it("returns the Anthropic client for claude-haiku-5-5 backed by ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    resetLlmClientCacheForTests();
    const config = getLlmClient("claude-haiku-5-5");
    expect(config.model).toBe("claude-haiku-5-5");
    expect(config.client).toBeInstanceOf(AnthropicChatClient);
  });

  it("throws LlmConfigError naming ANTHROPIC_API_KEY when the Anthropic key is missing", () => {
    process.env.OPENAI_API_KEY = "k";
    delete process.env.ANTHROPIC_API_KEY;
    resetLlmClientCacheForTests();
    expect(() => getLlmClient("claude-haiku-5-5")).toThrow(LlmConfigError);
    expect(() => getLlmClient("claude-haiku-5-5")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("still throws for the default model when OPENAI_API_KEY is missing", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "k";
    resetLlmClientCacheForTests();
    expect(() => getLlmClient()).toThrow(/OPENAI_API_KEY/);
  });

  it("throws LlmConfigError for an unknown model id", () => {
    process.env.OPENAI_API_KEY = "k";
    resetLlmClientCacheForTests();
    expect(() => getLlmClient("gpt-4")).toThrow(/unknown LLM model/i);
  });

  it("caches per model id: the same model reuses its client, reset clears them", () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.ANTHROPIC_API_KEY = "k";
    resetLlmClientCacheForTests();
    const luna = getLlmClient("gpt-6-luna");
    expect(getLlmClient("gpt-6-luna").client).toBe(luna.client);
    const haiku = getLlmClient("claude-haiku-5-5");
    expect(haiku.client).not.toBe(luna.client);
    resetLlmClientCacheForTests();
    expect(getLlmClient("gpt-6-luna").client).not.toBe(luna.client);
  });
});
