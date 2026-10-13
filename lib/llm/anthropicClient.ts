/**
 * Anthropic adapter — implements the neutral {@link ChatClient} surface on
 * top of Anthropic's Messages API, for the claude-haiku-5-5 model family.
 *
 * The mapping follows Anthropic's Claude Haiku 5.5 contract (migration
 * guide, 2026-10):
 * - the Chat-Completions `system` message becomes the top-level `system`
 *   param (Messages API has no system role);
 * - `max_tokens` is required — sized to fit the JSON guide plus the
 *   adaptive-thinking blocks that count toward it;
 * - `temperature`/`top_p`/`top_k` are NEVER sent (any non-default value is
 *   a 400 on this model); prompting carries the guidance instead;
 * - `reasoning_effort` maps to `output_config.effort`;
 * - the reply is assembled from `type: "text"` content blocks only —
 *   adaptive thinking can prepend `thinking` blocks even when unrequested,
 *   so blocks are selected by type, never by position;
 * - `stop_reason: "refusal"` and out-of-tokens replies throw readable
 *   errors the routes surface as 502s.
 */

import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { ChatClient, ChatParams, ChatResponse } from "./chat";

/** The slice of the Anthropic SDK surface the adapter uses (stub-able in tests). */
export interface AnthropicMessagesApi {
  create(params: MessageCreateParamsNonStreaming): Promise<Message>;
}

/** Room for the largest guide JSON plus adaptive-thinking tokens. */
const MAX_OUTPUT_TOKENS = 16_000;

export class AnthropicChatClient implements ChatClient {
  readonly chat: {
    completions: {
      create(params: ChatParams): Promise<ChatResponse>;
    };
  };

  constructor(private readonly messages: AnthropicMessagesApi) {
    this.chat = {
      completions: {
        create: async (params) => this.create(params),
      },
    };
  }

  private async create(params: ChatParams): Promise<ChatResponse> {
    const system = params.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const userTurns = params.messages
      .filter((message) => message.role === "user")
      .map((message): MessageCreateParamsNonStreaming["messages"][number] => ({
        role: "user",
        content: message.content,
      }));

    const effort =
      params.reasoning_effort === undefined
        ? undefined
        : params.reasoning_effort === "minimal"
          ? "low"
          : params.reasoning_effort;

    const request: MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: userTurns,
      ...(system.length > 0 ? { system } : {}),
      ...(effort === undefined ? {} : { output_config: { effort } }),
      // Deliberately absent: temperature, top_p, top_k (400 errors on Haiku
      // 5.5) and `thinking` (adaptive thinking is the default).
    };
    const response = await this.messages.create(request);

    if (response.stop_reason === "refusal") {
      throw new Error("CityCode: the model declined this request — try again or pick a different model");
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length === 0 && response.stop_reason === "max_tokens") {
      throw new Error("CityCode: the model hit its output token limit before returning usable text — try again");
    }
    return { choices: [{ message: { content: text } }] };
  }
}
