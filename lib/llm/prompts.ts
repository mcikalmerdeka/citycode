/**
 * LLM prompts (Phase 3) — pure prompt construction plus the single
 * "explain this file" chat call. No fs, no network in the builders; the
 * network call goes through the shared client so routes stay thin.
 */

import type { CodeGraph, FileNode } from "../types";
import type { ChangedFile } from "../git/diff";
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

/* ------------------------------------------------------------------ *
 * Phase 4 — the one-commit change summary
 * ------------------------------------------------------------------ */

export const SUMMARIZE_SYSTEM_PROMPT =
  "You summarize commits for developers in plain English. " +
  "Given the files a commit changed (added/modified/deleted/renamed) and each file's diff hunk headers, " +
  "explain what this commit most likely did and its likely impact on the codebase. " +
  "Answer in one short paragraph (3-5 sentences). No code fragments, no bullet lists, no markdown.";

const MAX_FILES_IN_DIFF_PROMPT = 40;
const MAX_HUNKS_PER_FILE = 5;

/** The user message for the one compare-view change summary. */
export function buildSummarizeUserPrompt(files: readonly ChangedFile[]): string {
  const included = files.slice(0, MAX_FILES_IN_DIFF_PROMPT);
  const overflow = files.length - included.length;
  const sections = included.map((file) => {
    const hunks = file.hunkHeaders
      .map((hunk) => hunk.replace(/\s+$/, ""))
      .filter((hunk) => hunk.length > 0)
      .slice(0, MAX_HUNKS_PER_FILE)
      .map((hunk) => `    ${hunk}`)
      .join("\n");
    const renameNote = file.kind === "renamed" && file.oldPath !== undefined ? ` (was ${file.oldPath})` : "";
    const hunksLine = hunks.length > 0 ? `\n  hunks:\n${hunks}` : "";
    return `- ${file.kind}: ${file.path}${renameNote}${hunksLine}`;
  });
  return (
    [
      "Commit summary request — changed files:",
      ...sections,
      overflow > 0 ? `(+${overflow} more files)` : "",
      "",
      "In plain English, what did this commit change and what is its likely blast radius?",
    ]
      .filter((line) => line.length > 0 || sections.length === 0)
      .join("\n") + (files.length === 0 ? "\n(no changed files)" : "")
  );
}

/**
 * One LLM chat call summarizing the whole commit; returns the plain-English
 * paragraph. Thrown errors are mapped to user-facing messages by the route.
 */
export async function summarizeDiff(files: readonly ChangedFile[]): Promise<{ summary: string }> {
  const { client, model } = getLlmClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
      { role: "user", content: buildSummarizeUserPrompt(files) },
    ],
    // Same reasoning-notes contract as explainFile: reasoning effort != none
    // rejects temperature/top_p, so neither is sent.
    reasoning_effort: LLM_REASONING_EFFORT,
  });
  const summary = (response.choices[0]?.message?.content ?? "").trim();
  if (summary.length === 0) {
    throw new Error("CityCode: the model returned an empty change summary");
  }
  return { summary };
}
