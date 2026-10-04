/**
 * Grounding layer — turns raw model JSON into guide data the UI can trust.
 *
 * An LLM will happily invent file paths, function names and line numbers.
 * Nothing it returns reaches the client or a snapshot without passing
 * through here, where every reference is checked against the real
 * {@link CodeGraph}:
 *
 * - file ids must exist in the graph (unknown ones are dropped, never guessed);
 * - function names are matched to graph symbols, and when the model's cited
 *   lines disagree with the symbol's real span the span wins;
 * - line ranges are clamped to the actual file and to a readable length;
 * - text is trimmed and length-capped so one runaway field can't break the UI.
 *
 * Pure functions only (no fs, no network) — the file contents needed for
 * code excerpts are passed in, which keeps this module trivially testable.
 */

import type { CodeGraph, FileNode, SymbolDef } from "../types";
import type {
  GuideFeature,
  ReadingStop,
  RepoGuide,
  WorkflowDetail,
  WorkflowStep,
  WorkflowStop,
  WorkflowSummary,
  CodeExcerpt,
} from "./types";

/** Hard caps — the single place where "how much is too much" is decided. */
export const GUIDE_LIMITS = {
  identity: 1200,
  dataFlow: 1500,
  title: 80,
  summary: 400,
  why: 300,
  goal: 240,
  trigger: 240,
  stepTitle: 70,
  narration: 420,
  payload: 90,
  features: 8,
  featureFiles: 6,
  readingPath: 10,
  workflows: 6,
  routeStops: 10,
  steps: 14,
  /** Longest highlighted range — a highlight that spans a whole file says nothing. */
  highlightLines: 24,
  /** Fallback highlight when the model gave neither a symbol nor valid lines. */
  headLines: 20,
  excerptContext: 4,
  excerptLines: 60,
  lineChars: 220,
} as const;

const L = GUIDE_LIMITS;

const UNUSABLE_GUIDE = "CityCode: the model returned an unusable repository guide — try again";
const UNUSABLE_TRACE = "CityCode: the model returned an unusable workflow trace — try again";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collapse whitespace, trim, and cap length (with an ellipsis) — "" for non-strings. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** Repo-relative POSIX form of a model-provided path ("./a\\b.ts" → "a/b.ts"). */
export function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Lowercase url-safe slug of a title — "Import a repo!" → "import-a-repo". */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "workflow";
}

/**
 * Pull the JSON object out of a model reply: tolerates code fences and
 * chatter around the object. Throws a readable error when there is none.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("CityCode: the model did not return a JSON object — try again");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("CityCode: the model's JSON could not be parsed — try again");
  }
}

/** Split file contents into lines the way the graph counts LOC (no phantom trailing line). */
export function splitLines(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function indexFiles(graph: CodeGraph): Map<string, FileNode> {
  return new Map(graph.files.map((file) => [file.id, file]));
}

function basename(fileId: string): string {
  return fileId.slice(fileId.lastIndexOf("/") + 1);
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Match a model-provided function name to a graph symbol (exact → case-insensitive → last dotted part). */
function matchSymbol(file: FileNode, raw: unknown): SymbolDef | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().replace(/\(\)$/, "");
  if (name.length === 0) return undefined;
  const lower = name.toLowerCase();
  const tail = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : undefined;
  return (
    file.functions.find((fn) => fn.name === name) ??
    file.functions.find((fn) => fn.name.toLowerCase() === lower) ??
    (tail === undefined ? undefined : file.functions.find((fn) => fn.name === tail))
  );
}

/* ------------------------------------------------------------------ *
 * Phase A — the guide
 * ------------------------------------------------------------------ */

function groundRoute(raw: unknown, byId: ReadonlyMap<string, FileNode>): WorkflowStop[] {
  const stops: WorkflowStop[] = [];
  for (const item of asArray(raw)) {
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const file = byId.get(normalizePath(rec.file ?? rec.fileId));
    if (file === undefined) continue;
    const symbol = matchSymbol(file, rec.symbol)?.name;
    const previous = stops[stops.length - 1];
    if (previous !== undefined && previous.fileId === file.id && previous.symbol === symbol) continue;
    stops.push(symbol === undefined ? { fileId: file.id } : { fileId: file.id, symbol });
    if (stops.length >= L.routeStops) break;
  }
  return stops;
}

function groundWorkflows(
  raw: unknown,
  byId: ReadonlyMap<string, FileNode>,
  usedIds: Set<string> = new Set(),
): WorkflowSummary[] {
  const workflows: WorkflowSummary[] = [];
  for (const item of asArray(raw)) {
    if (workflows.length >= L.workflows) break;
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const title = clean(rec.title, L.title);
    const goal = clean(rec.goal, L.goal);
    const route = groundRoute(rec.route, byId);
    // A "flow" inside a single file has nothing to animate between.
    if (title.length === 0 || goal.length === 0 || new Set(route.map((s) => s.fileId)).size < 2) continue;
    const base = slugify(title);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    workflows.push({ id, title, goal, trigger: clean(rec.trigger, L.trigger), route });
  }
  return workflows;
}

function groundFeatures(raw: unknown, byId: ReadonlyMap<string, FileNode>): GuideFeature[] {
  const features: GuideFeature[] = [];
  for (const item of asArray(raw)) {
    if (features.length >= L.features) break;
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const title = clean(rec.title, L.title);
    const summary = clean(rec.summary, L.summary);
    if (title.length === 0 || summary.length === 0) continue;
    const files = unique(
      asArray(rec.files)
        .map(normalizePath)
        .filter((id) => byId.has(id)),
    ).slice(0, L.featureFiles);
    features.push({ title, summary, files });
  }
  return features;
}

function groundReadingPath(raw: unknown, byId: ReadonlyMap<string, FileNode>): ReadingStop[] {
  const stops: ReadingStop[] = [];
  const seen = new Set<string>();
  for (const item of asArray(raw)) {
    if (stops.length >= L.readingPath) break;
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const fileId = normalizePath(rec.file ?? rec.fileId);
    if (!byId.has(fileId) || seen.has(fileId)) continue;
    const why = clean(rec.why, L.why);
    if (why.length === 0) continue;
    seen.add(fileId);
    stops.push({ fileId, why });
  }
  return stops;
}

/**
 * Validate and sanitize the model's guide JSON against the graph. Throws a
 * readable error when nothing usable is left (no identity, or neither
 * features nor workflows) — the route maps that to a 502 with Retry.
 */
export function groundGuide(raw: unknown, graph: CodeGraph): RepoGuide {
  const rec = asRecord(raw);
  if (rec === undefined) throw new Error(UNUSABLE_GUIDE);
  const byId = indexFiles(graph);
  const identity = clean(rec.identity, L.identity);
  const features = groundFeatures(rec.features, byId);
  const workflows = groundWorkflows(rec.workflows, byId);
  if (identity.length === 0 || (features.length === 0 && workflows.length === 0)) {
    throw new Error(UNUSABLE_GUIDE);
  }
  return {
    identity,
    workflows,
    features,
    readingPath: groundReadingPath(rec.readingPath, byId),
    dataFlow: clean(rec.dataFlow, L.dataFlow),
  };
}

/**
 * Ground ONE workflow the model designed for a user's question. Same rules
 * as the guide's own workflows (real files only, ≥ 2 distinct files); the id
 * is made unique against `existingIds`. Accepts `{ workflow: {...} }` or the
 * bare object. Throws a readable error when the question could not be mapped
 * onto this repo's files.
 */
export function groundCustomWorkflow(
  raw: unknown,
  graph: CodeGraph,
  existingIds: Iterable<string>,
): WorkflowSummary {
  const rec = asRecord(raw);
  const candidate = asRecord(rec?.workflow) ?? rec;
  const [workflow] = groundWorkflows([candidate], indexFiles(graph), new Set(existingIds));
  if (workflow === undefined) {
    throw new Error("CityCode: that question could not be mapped onto files in this repo — try rephrasing it");
  }
  return workflow;
}

/* ------------------------------------------------------------------ *
 * Phase B — a traced workflow
 * ------------------------------------------------------------------ */

interface Span {
  startLine: number;
  endLine: number;
}

function toLine(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : undefined;
}

function capSpan(span: Span): Span {
  return { startLine: span.startLine, endLine: Math.min(span.endLine, span.startLine + L.highlightLines - 1) };
}

/**
 * Decide the highlighted line range of one step. The model's own lines win
 * when they are valid and agree with the named function's real span; a
 * disagreement means the model miscounted, so the symbol's span is used;
 * with neither, the top of the file stands in. Always within [1, total].
 */
export function resolveRange(
  total: number,
  symbol: SymbolDef | undefined,
  rawStart: unknown,
  rawEnd: unknown,
): Span {
  const a = toLine(rawStart);
  const b = toLine(rawEnd);
  let cited: Span | undefined;
  if (a !== undefined && b !== undefined) {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (start >= 1 && start <= total) cited = { startLine: start, endLine: Math.min(end, total) };
  }
  const span: Span | undefined =
    symbol !== undefined && symbol.startLine >= 1 && symbol.startLine <= total
      ? { startLine: symbol.startLine, endLine: Math.min(symbol.endLine, total) }
      : undefined;

  if (cited !== undefined && (span === undefined || (cited.startLine <= span.endLine && cited.endLine >= span.startLine))) {
    return capSpan(cited);
  }
  if (span !== undefined) return capSpan(span);
  if (cited !== undefined) return capSpan(cited);
  return { startLine: 1, endLine: Math.min(total, L.headLines) };
}

function displayLine(line: string): string {
  const spaced = line.replace(/\t/g, "  ");
  return spaced.length > L.lineChars ? `${spaced.slice(0, L.lineChars - 1)}…` : spaced;
}

/** The highlighted range plus a few lines of context on each side. */
export function buildExcerpt(lines: readonly string[], range: Span): CodeExcerpt {
  const from = Math.max(1, range.startLine - L.excerptContext);
  const to = Math.min(lines.length, range.endLine + L.excerptContext, from + L.excerptLines - 1);
  return { startLine: from, lines: lines.slice(from - 1, to).map(displayLine) };
}

function groundStep(
  item: unknown,
  byId: ReadonlyMap<string, FileNode>,
  sources: ReadonlyMap<string, readonly string[]>,
): WorkflowStep | undefined {
  const rec = asRecord(item);
  if (rec === undefined) return undefined;
  const file = byId.get(normalizePath(rec.file ?? rec.fileId));
  if (file === undefined) return undefined;
  const narration = clean(rec.narration, L.narration);
  if (narration.length === 0) return undefined;

  const symbol = matchSymbol(file, rec.symbol);
  const lines = sources.get(file.id);
  const total = Math.max(1, lines?.length ?? file.loc);
  const range = resolveRange(total, symbol, rec.startLine, rec.endLine);
  const title = clean(rec.title, L.stepTitle) || (symbol !== undefined ? `Run ${symbol.name}` : basename(file.id));
  const payload = clean(rec.payload, L.payload);

  const step: WorkflowStep = { fileId: file.id, title, narration, startLine: range.startLine, endLine: range.endLine };
  if (symbol !== undefined) step.symbol = symbol.name;
  if (payload.length > 0) step.payload = payload;
  if (lines !== undefined && lines.length > 0) step.excerpt = buildExcerpt(lines, range);
  return step;
}

/**
 * Validate and sanitize the model's workflow trace. `sources` maps file id →
 * the file's lines (only files that could be read; others get no excerpt).
 * Throws when fewer than two real steps survive — one step is not a flow.
 */
export function groundWorkflowDetail(
  raw: unknown,
  graph: CodeGraph,
  workflowId: string,
  sources: ReadonlyMap<string, readonly string[]>,
): WorkflowDetail {
  const rec = asRecord(raw);
  if (rec === undefined) throw new Error(UNUSABLE_TRACE);
  const byId = indexFiles(graph);
  const steps: WorkflowStep[] = [];
  for (const item of asArray(rec.steps)) {
    if (steps.length >= L.steps) break;
    const step = groundStep(item, byId, sources);
    if (step !== undefined) steps.push(step);
  }
  if (steps.length < 2) throw new Error(UNUSABLE_TRACE);
  // The last step hands nothing on.
  delete steps[steps.length - 1]!.payload;
  return { workflowId, steps };
}
