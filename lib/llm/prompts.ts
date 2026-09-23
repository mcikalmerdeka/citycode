/**
 * LLM prompts (Phase 3) — pure prompt construction plus the single
 * "explain this file" chat call. No fs, no network in the builders; the
 * network call goes through the shared client so routes stay thin.
 */

import type { CodeGraph, FileNode } from "../types";
import { getLlmClient, LLM_REASONING_EFFORT } from "./client";

export const EXPLAIN_SYSTEM_PROMPT =
  "You explain codebases to developers in plain English. " +
  "Given a file's path, size, declared functions, and how it connects to the rest of the repo, " +
  "explain what this file most likely does and why it matters. " +
  "Answer in 2-4 short sentences. No code fragments, no bullet lists, no markdown.";

/** Caps keep the prompt bounded for huge files (PRD risk §11 mindset). */
const MAX_FUNCTIONS_IN_PROMPT = 40;
const MAX_LINKED_FILES_IN_PROMPT = 20;

function capList(items: string[], max: number): string {
  const trimmed = items.slice(0, max);
  const overflow = items.length - trimmed.length;
  return trimmed.length === 0 ? "(none)" : trimmed.join(", ") + (overflow > 0 ? ` … (+${overflow} more)` : "");
}

/** The user message for one file-explanation request. */
export function buildExplainUserPrompt(graph: CodeGraph, file: FileNode): string {
  const importers = graph.edges.filter((edge) => edge.toId === file.id).map((edge) => edge.fromId);
  const importees = graph.edges.filter((edge) => edge.fromId === file.id).map((edge) => edge.toId);
  const functions = file.functions.map(
    (fn) => `${fn.name} (lines ${fn.startLine}-${fn.endLine})`,
  );

  return [
    `File path: ${file.path}`,
    `Language: ${file.language}`,
    `Lines of code: ${file.loc}`,
    `Functions declared: ${capList(functions, MAX_FUNCTIONS_IN_PROMPT)}`,
    `Imported by: ${capList([...new Set(importers)].sort(), MAX_LINKED_FILES_IN_PROMPT)}`,
    `Imports (repo-internal): ${capList([...new Set(importees)].sort(), MAX_LINKED_FILES_IN_PROMPT)}`,
    `Packages it imports: ${capList(file.externalImports, MAX_LINKED_FILES_IN_PROMPT)}`,
    "In plain English, what does this file do and why does it matter to the rest of the codebase?",
  ].join("\n");
}

/**
 * One LLM chat call explaining a file; returns the plain-English summary.
 * Model/endpoint come from the shared client (env-driven). Thrown errors are
 * mapped to user-facing messages by the route.
 */
export async function explainFile(
  graph: CodeGraph,
  file: FileNode,
): Promise<{ summary: string }> {
  const { client, model } = getLlmClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
      { role: "user", content: buildExplainUserPrompt(graph, file) },
    ],
    // gpt-6-luna reasoning notes (OpenAI model guidance, 2026-09): with
    // reasoning effort != "none", Chat Completions rejects temperature/
    // top_p — so neither is set, and no token cap is forced either.
    reasoning_effort: LLM_REASONING_EFFORT,
  });
  const summary = (response.choices[0]?.message?.content ?? "").trim();
  if (summary.length === 0) {
    throw new Error("CityCode: the model returned an empty explanation");
  }
  return { summary };
}
