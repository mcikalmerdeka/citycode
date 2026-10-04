/**
 * Repo Guidance prompts — the two LLM calls behind the guided demos.
 *
 * - Phase A, {@link generateRepoGuide}: one call per repo state. The model
 *   sees the structure, an index of citable files, the import links between
 *   them, and a few key files, and returns the guide as JSON (identity,
 *   workflows, features, reading path, data flow).
 * - Phase B, {@link traceWorkflow}: one call per workflow, made lazily when
 *   the user picks it. The model sees the real, LINE-NUMBERED source of just
 *   the files on that workflow's route, so the line ranges it cites are
 *   grounded in text it actually read.
 *
 * Builders are pure (no fs, no network); the calls go through the shared
 * client like every other LLM feature, and everything the model returns is
 * validated by lib/guidance/ground.ts before it leaves this module.
 */

import {
  describeIndexEntry,
  indexEdgeLines,
  rankIndexFiles,
} from "../guidance/fileIndex";
import {
  extractJsonObject,
  groundCustomWorkflow,
  groundGuide,
  groundWorkflowDetail,
} from "../guidance/ground";
import type { RepoGuide, WorkflowDetail, WorkflowSummary } from "../guidance/types";
import type { CodeGraph } from "../types";
import { getLlmClient, LLM_REASONING_EFFORT } from "./client";
import type { KeyFileSelection } from "./keyFiles";

const INDEX_MAX_FILES = 140;
const INDEX_MAX_EDGE_LINES = 160;
const MAX_TREE_LINES = 40;
/** Total characters of source shown to the model for one workflow trace. */
const WORKFLOW_SOURCE_BUDGET = 44_000;
const MIN_PER_FILE_BUDGET = 4_000;
/** Lines of a file always shown (imports + setup) when it must be windowed. */
const HEAD_WINDOW_LINES = 40;
const FOCUS_CONTEXT_LINES = 3;
const MAX_PROMPT_LINE_CHARS = 300;

/* ------------------------------------------------------------------ *
 * Phase A — the guide
 * ------------------------------------------------------------------ */

export const GUIDE_SYSTEM_PROMPT = [
  "You are the onboarding guide inside CityCode, a tool that shows a codebase as a 3D city (files are buildings, imports are roads).",
  "Explain the repository to a newcomer and design interactive guided demos of how its data flows.",
  "Reply with ONE JSON object and nothing else - no markdown, no code fences. Shape (the // notes are instructions, not part of the JSON):",
  "{",
  '  "identity": string,   // 2-4 plain-English sentences: what this repo is and who it is for',
  '  "workflows": [        // 3-6 concrete things a person can DO with this app, each traced through real files',
  "    {",
  '      "title": string,    // a verb phrase, e.g. "Import a GitHub repository"',
  '      "goal": string,     // one sentence: what the person achieves',
  '      "trigger": string,  // one sentence: the action or event that starts it',
  '      "route": [ { "file": string, "symbol": string } ]  // 3-9 stops in execution order, trigger first, result last; "symbol" is optional',
  "    }",
  "  ],",
  '  "features": [ { "title": string, "summary": string, "files": [string] } ],  // 3-6 main features, most important first, 1-4 files each',
  '  "readingPath": [ { "file": string, "why": string } ],                      // 5-8 files in the order a newcomer should read them',
  '  "dataFlow": string    // 3-6 sentences: how input becomes output across the main modules',
  "}",
  "Rules:",
  '- Every "file" MUST be copied exactly from the FILE INDEX. Never invent a path. A "symbol" must be a function name listed for that file, otherwise omit it.',
  "- Make each workflow's route follow real hand-offs: consecutive stops should usually be connected by an IMPORT LINK (caller -> callee). Start at the file where the action enters the app (UI, API route, CLI command, job) and end where the result is produced.",
  "- Workflows must differ from each other, and each must touch at least 2 different files.",
  "- Plain English. No code fragments, no markdown. Keep every string short and concrete.",
  "- If the prompt says the repo was analyzed in summarized mode (no function or import data), design routes from the paths and excerpts alone and say so in dataFlow.",
].join("\n");

function topLevelFolderLines(graph: CodeGraph): string[] {
  const topDirs = new Map<string, { files: number; loc: number }>();
  for (const file of graph.files) {
    const segments = file.id.split("/");
    const dir = segments.length === 1 ? "(root files)" : segments[0]!;
    const entry = topDirs.get(dir) ?? { files: 0, loc: 0 };
    entry.files += 1;
    entry.loc += file.loc;
    topDirs.set(dir, entry);
  }
  return [...topDirs.entries()]
    .sort((a, b) => b[1].loc - a[1].loc || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_TREE_LINES)
    .map(([dir, entry]) => `${dir} (${entry.files} files, ${entry.loc} lines)`);
}

/** The user message for the guide request (pure). */
export function buildGuideUserPrompt(graph: CodeGraph, keyFiles: KeyFileSelection): string {
  const totalLoc = graph.files.reduce((sum, file) => sum + file.loc, 0);
  const indexed = rankIndexFiles(graph, INDEX_MAX_FILES).sort((a, b) =>
    a.file.id < b.file.id ? -1 : a.file.id > b.file.id ? 1 : 0,
  );
  const indexedIds = new Set(indexed.map((entry) => entry.file.id));
  const edgeLines = indexEdgeLines(graph, indexedIds, INDEX_MAX_EDGE_LINES);
  const fileBlocks = keyFiles.files.map((file) => `--- ${file.path}\n${file.contents}`);
  // Skim-mode graphs carry no functions and no edges — say so the guide can caveat itself.
  const skim =
    graph.edges.length === 0 && graph.files.every((file) => file.functions.length === 0)
      ? "(Note: this repo was analyzed in summarized mode — function and import data was omitted, so work from paths, sizes, and the excerpts below.)"
      : "";

  return [
    `Source: ${graph.source} — ${graph.repoPath}`,
    `Files: ${graph.files.length} · Total lines of code: ${totalLoc}`,
    "Top-level folders:",
    ...topLevelFolderLines(graph),
    skim,
    `FILE INDEX (${indexed.length} of ${graph.files.length} files — cite ONLY these exact paths):`,
    ...indexed.map(describeIndexEntry),
    "IMPORT LINKS among indexed files (importer -> imported{symbols}):",
    ...(edgeLines.length === 0 ? ["(none)"] : edgeLines),
    "KEY FILE EXCERPTS:",
    ...fileBlocks,
    "",
    "Produce the JSON guide described in your instructions.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function replyText(response: { choices: Array<{ message?: { content?: string | null } }> }): string {
  return (response.choices[0]?.message?.content ?? "").trim();
}

/**
 * One LLM call generating the guide. Thrown errors (empty reply, bad JSON,
 * nothing usable after grounding) are mapped to a 502 by the route. Same
 * reasoning-notes contract as explainFile: reasoning effort != none rejects
 * temperature/top_p, so neither is sent.
 */
export async function generateRepoGuide(
  graph: CodeGraph,
  keyFiles: KeyFileSelection,
): Promise<{ guide: RepoGuide }> {
  const { client, model } = getLlmClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: GUIDE_SYSTEM_PROMPT },
      { role: "user", content: buildGuideUserPrompt(graph, keyFiles) },
    ],
    reasoning_effort: LLM_REASONING_EFFORT,
  });
  const text = replyText(response);
  if (text.length === 0) throw new Error("CityCode: the model returned an empty repository guide");
  return { guide: groundGuide(extractJsonObject(text), graph) };
}

/* ------------------------------------------------------------------ *
 * Custom demo — a workflow designed from the user's own question
 * ------------------------------------------------------------------ */

export const ASK_SYSTEM_PROMPT = [
  "You are the onboarding guide inside CityCode. A user asked how something works in this repository.",
  "Design ONE guided demo that answers the question by following the data or control flow through real files.",
  "Reply with ONE JSON object and nothing else - no markdown, no code fences. Shape (the // notes are instructions, not part of the JSON):",
  "{",
  '  "title": string,    // a short phrase naming the flow, e.g. "How a pasted URL becomes a city"',
  '  "goal": string,     // one sentence: what this demo explains, answering the question',
  '  "trigger": string,  // one sentence: the action or event that starts the flow',
  '  "route": [ { "file": string, "symbol": string } ]  // 3-9 stops in execution order, trigger first, result last; "symbol" is optional',
  "}",
  "Rules:",
  '- Every "file" MUST be copied exactly from the FILE INDEX. Never invent a path. A "symbol" must be a function name listed for that file, otherwise omit it.',
  "- Follow real hand-offs: consecutive stops should usually be connected by an IMPORT LINK (caller -> callee). Touch at least 2 different files.",
  "- Stay on the user's question. Plain English, short and concrete, no markdown.",
].join("\n");

/** The user message for a custom-demo request (pure). */
export function buildAskUserPrompt(graph: CodeGraph, question: string): string {
  const indexed = rankIndexFiles(graph, INDEX_MAX_FILES).sort((a, b) =>
    a.file.id < b.file.id ? -1 : a.file.id > b.file.id ? 1 : 0,
  );
  const edgeLines = indexEdgeLines(graph, new Set(indexed.map((entry) => entry.file.id)), INDEX_MAX_EDGE_LINES);
  const skim =
    graph.edges.length === 0 && graph.files.every((file) => file.functions.length === 0)
      ? "(Note: summarized mode — no function or import data; work from paths and sizes.)"
      : "";
  return [
    `QUESTION: ${question}`,
    `Source: ${graph.source} — ${graph.repoPath}`,
    skim,
    `FILE INDEX (${indexed.length} of ${graph.files.length} files — cite ONLY these exact paths):`,
    ...indexed.map(describeIndexEntry),
    "IMPORT LINKS among indexed files (importer -> imported{symbols}):",
    ...(edgeLines.length === 0 ? ["(none)"] : edgeLines),
    "",
    "Produce the JSON demo described in your instructions.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * One LLM call designing a demo for the user's question. The result is
 * grounded against the graph (real files only) and gets a unique id.
 */
export async function designWorkflow(
  graph: CodeGraph,
  question: string,
  existingIds: Iterable<string>,
): Promise<{ workflow: WorkflowSummary }> {
  const { client, model } = getLlmClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: buildAskUserPrompt(graph, question) },
    ],
    reasoning_effort: LLM_REASONING_EFFORT,
  });
  const text = replyText(response);
  if (text.length === 0) throw new Error("CityCode: the model returned an empty demo");
  const workflow = groundCustomWorkflow(extractJsonObject(text), graph, existingIds);
  return { workflow: { ...workflow, question } };
}

/* ------------------------------------------------------------------ *
 * Phase B — one traced workflow
 * ------------------------------------------------------------------ */

export const WORKFLOW_SYSTEM_PROMPT = [
  "You trace one workflow through real source code for a guided visual demo in CityCode.",
  "Reply with ONE JSON object and nothing else - no markdown, no code fences. Shape (the // note is an instruction, not part of the JSON):",
  '{ "steps": [ { "file": string, "symbol": string, "startLine": number, "endLine": number, "title": string, "narration": string, "payload": string } ] }  // "symbol" and "payload" are optional',
  "Rules:",
  "- 3-10 steps in execution order: where the action enters the app, each hand-off, where the result is produced. Follow the planned ROUTE, but add a step the code clearly shows or drop one it does not.",
  '- "file" must be copied exactly from the SOURCE FILES headings. Never invent files.',
  "- startLine/endLine are 1-based line numbers exactly as printed at the left of the source (`N| code`). Pick the 3-20 lines where this step actually happens (the call, the check, the transformation) - not a whole function. Never go past a file's last line.",
  '- "title": at most 6 words, phrased as an action ("Validate the GitHub URL").',
  '- "narration": 1-2 plain-English sentences about what happens at those lines and why it matters. No code fragments, no markdown.',
  '- "payload": at most 8 words naming the data handed to the NEXT step (e.g. "parsed code graph"). Omit it on the last step.',
].join("\n");

interface LineWindow {
  startLine: number;
  endLine: number;
}

function mergeWindows(windows: readonly LineWindow[]): LineWindow[] {
  const sorted = windows.map((window) => ({ ...window })).sort((a, b) => a.startLine - b.startLine);
  const merged: LineWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, window.endLine);
    } else {
      merged.push(window);
    }
  }
  return merged;
}

/**
 * Render a file as `N| code` lines within `maxChars`. When the whole file
 * fits it is shown whole; otherwise only the head plus windows around the
 * `focus` ranges are shown (original line numbers kept, gaps marked) — so
 * the model reads the code the workflow actually runs through. With no
 * focus the file is shown from the top until the budget runs out.
 */
export function renderNumberedSource(
  lines: readonly string[],
  focus: readonly LineWindow[],
  maxChars: number,
): string {
  const total = lines.length;
  const pad = String(total).length;
  const format = (n: number): string => `${String(n).padStart(pad, " ")}| ${lines[n - 1]!.slice(0, MAX_PROMPT_LINE_CHARS)}`;
  const gap = (from: number, to: number): string => `${" ".repeat(pad)}  … (lines ${from}–${to} omitted)`;

  const whole = lines.map((_, i) => format(i + 1)).join("\n");
  if (whole.length <= maxChars) return whole;

  const windows: LineWindow[] =
    focus.length === 0
      ? [{ startLine: 1, endLine: total }]
      : mergeWindows([
          { startLine: 1, endLine: Math.min(total, HEAD_WINDOW_LINES) },
          ...focus.map((f) => ({
            startLine: Math.max(1, f.startLine - FOCUS_CONTEXT_LINES),
            endLine: Math.min(total, f.endLine + FOCUS_CONTEXT_LINES),
          })),
        ]);

  const out: string[] = [];
  let used = 0;
  let cursor = 1;
  for (const window of windows) {
    if (window.startLine > cursor) out.push(gap(cursor, window.startLine - 1));
    for (let n = window.startLine; n <= window.endLine; n++) {
      const line = format(n);
      if (used + line.length + 1 > maxChars) {
        out.push(`${" ".repeat(pad)}  … (truncated after line ${n - 1})`);
        return out.join("\n");
      }
      out.push(line);
      used += line.length + 1;
    }
    cursor = window.endLine + 1;
  }
  if (cursor <= total) out.push(gap(cursor, total));
  return out.join("\n");
}

/** The user message for one workflow trace (pure). */
export function buildWorkflowUserPrompt(
  graph: CodeGraph,
  workflow: WorkflowSummary,
  sources: ReadonlyMap<string, readonly string[]>,
): string {
  const byId = new Map(graph.files.map((file) => [file.id, file]));
  const routeFiles = [...new Set(workflow.route.map((stop) => stop.fileId))];
  const perFile = Math.max(MIN_PER_FILE_BUDGET, Math.floor(WORKFLOW_SOURCE_BUDGET / Math.max(1, routeFiles.length)));

  const blocks = routeFiles.flatMap((fileId) => {
    const file = byId.get(fileId);
    if (file === undefined) return [];
    const lines = sources.get(fileId);
    const focus = workflow.route
      .filter((stop) => stop.fileId === fileId && stop.symbol !== undefined)
      .flatMap((stop) => file.functions.filter((fn) => fn.name === stop.symbol))
      .map((fn) => ({ startLine: fn.startLine, endLine: fn.endLine }));
    const functions =
      file.functions.length === 0
        ? ""
        : ` — functions: ${file.functions.map((fn) => `${fn.name} (lines ${fn.startLine}-${fn.endLine})`).join(", ")}`;
    return [
      `=== ${fileId} (${file.language}, ${lines?.length ?? file.loc} lines)${functions}`,
      lines === undefined ? "(source unavailable — rely on the function list)" : renderNumberedSource(lines, focus, perFile),
    ];
  });

  const links = indexEdgeLines(graph, new Set(routeFiles), 40);
  return [
    `WORKFLOW: ${workflow.title}`,
    `GOAL: ${workflow.goal}`,
    `TRIGGER: ${workflow.trigger}`,
    "PLANNED ROUTE:",
    ...workflow.route.map((stop, i) => `${i + 1}. ${stop.fileId}${stop.symbol === undefined ? "" : ` :: ${stop.symbol}`}`),
    "IMPORT LINKS among these files (importer -> imported{symbols}):",
    ...(links.length === 0 ? ["(none)"] : links),
    "SOURCE FILES (every line is printed as `N| code`):",
    ...blocks,
    "",
    "Produce the JSON trace described in your instructions.",
  ].join("\n");
}

/**
 * One LLM call tracing a workflow through its files. `sources` maps file id →
 * lines for the route's readable files (see lib/guidance/sources.ts).
 */
export async function traceWorkflow(
  graph: CodeGraph,
  workflow: WorkflowSummary,
  sources: ReadonlyMap<string, readonly string[]>,
): Promise<{ detail: WorkflowDetail }> {
  const { client, model } = getLlmClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: WORKFLOW_SYSTEM_PROMPT },
      { role: "user", content: buildWorkflowUserPrompt(graph, workflow, sources) },
    ],
    reasoning_effort: LLM_REASONING_EFFORT,
  });
  const text = replyText(response);
  if (text.length === 0) throw new Error("CityCode: the model returned an empty workflow trace");
  return { detail: groundWorkflowDetail(extractJsonObject(text), graph, workflow.id, sources) };
}
