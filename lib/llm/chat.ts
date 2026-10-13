/**
 * Provider-neutral chat-call surface.
 *
 * CityCode's LLM call sites were written against the OpenAI SDK shape
 * (`client.chat.completions.create({ model, messages, reasoning_effort })`).
 * Adding a second provider (Anthropic) without rewriting five call sites
 * means both adapters implement exactly that surface, typed HERE so the
 * call sites never touch a vendor SDK directly:
 *
 * - openAiClient.ts — forwards to the OpenAI SDK (the original behavior);
 * - anthropicClient.ts — maps to Anthropic's Messages API (system prompt
 *   extracted to the top-level `system` param, reply text pulled from
 *   `text` content blocks).
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
}

export interface ChatResponse {
  choices: Array<{ message?: { content?: string | null } }>;
}

export interface ChatClient {
  chat: {
    completions: {
      create(params: ChatParams): Promise<ChatResponse>;
    };
  };
}

/** Reasoning effort applied to every CityCode summarization call. */
export const LLM_REASONING_EFFORT = "medium" as const;
