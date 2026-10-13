/**
 * OpenAI adapter — implements the neutral {@link ChatClient} surface by
 * forwarding to the OpenAI SDK. This is the original provider: the mapping
 * is a pass-through plus a response trim, so existing behavior (the
 * `reasoning_effort` parameter, no temperature/top_p, no token cap) is
 * unchanged.
 */

import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatClient, ChatParams, ChatResponse } from "./chat";

/** The slice of the OpenAI SDK surface the adapter uses (stub-able in tests). */
export interface OpenAiCompletionsApi {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
}

export class OpenAiChatClient implements ChatClient {
  readonly chat: {
    completions: {
      create(params: ChatParams): Promise<ChatResponse>;
    };
  };

  constructor(private readonly completions: OpenAiCompletionsApi) {
    this.chat = {
      completions: {
        create: async (params) => this.create(params),
      },
    };
  }

  private async create(params: ChatParams): Promise<ChatResponse> {
    // Message roles are re-stated literally so each element gets the exact
    // SDK message type (a widened `{role, content}` array would not be).
    const messages: ChatCompletionMessageParam[] = params.messages.map((message) =>
      message.role === "system"
        ? { role: "system", content: message.content }
        : { role: "user", content: message.content },
    );
    const response = await this.completions.create({
      model: params.model,
      messages,
      ...(params.reasoning_effort === undefined ? {} : { reasoning_effort: params.reasoning_effort }),
    });
    return {
      choices: response.choices.map((choice) => ({
        message: { content: choice.message?.content ?? null },
      })),
    };
  }
}
