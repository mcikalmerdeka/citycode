/**
 * Repo Guidance data model — the one shape shared by the server-side
 * grounding layer, snapshot persistence, and the guidance UI.
 *
 * The guide is generated in two phases so line numbers can be trusted:
 *
 * 1. {@link RepoGuide} — one LLM call per repo state: identity, features,
 *    reading path, data-flow overview and a list of {@link WorkflowSummary}
 *    options ("things you can do with this app"), each a skeleton route
 *    through real files.
 * 2. {@link WorkflowDetail} — one LLM call per workflow, made lazily when the
 *    user picks it. The model sees the real, line-numbered source of the
 *    files on the route, so every step carries a verified line range plus a
 *    code excerpt for the demo's code viewer.
 *
 * Every file id in here is a graph file id (repo-relative POSIX path); the
 * grounding layer (ground.ts) guarantees that before anything is persisted
 * or sent to the client.
 */

/** A slice of a source file shown in the demo's code viewer. */
export interface CodeExcerpt {
  /** 1-based file line number of `lines[0]`. */
  startLine: number;
  lines: string[];
}

/** One stop on a workflow's skeleton route. */
export interface WorkflowStop {
  fileId: string;
  /** Canonical function name inside the file, when the model named one. */
  symbol?: string;
}

/** One selectable option in the guide: a concrete thing to do with the app. */
export interface WorkflowSummary {
  /** Server-assigned slug, unique within the guide. */
  id: string;
  title: string;
  /** One sentence: what the person achieves. */
  goal: string;
  /** One sentence: the action or event that starts the flow. */
  trigger: string;
  /** Ordered stops (trigger first, result last); ≥ 2 distinct files. */
  route: WorkflowStop[];
}

export interface GuideFeature {
  title: string;
  summary: string;
  /** Graph file ids that implement the feature. */
  files: string[];
}

export interface ReadingStop {
  fileId: string;
  why: string;
}

export interface RepoGuide {
  /** "What this repo is". */
  identity: string;
  /** Selectable workflow options — the interactive heart of the guide. */
  workflows: WorkflowSummary[];
  /** "Main features". */
  features: GuideFeature[];
  /** "Ordered reading path". */
  readingPath: ReadingStop[];
  /** "Data flow" overview narrative. */
  dataFlow: string;
}

/** One verified step of a traced workflow. */
export interface WorkflowStep {
  fileId: string;
  title: string;
  /** Plain-English account of what happens at this code. */
  narration: string;
  /** What data is handed to the next step (absent on the last step). */
  payload?: string;
  symbol?: string;
  /** 1-based inclusive highlight range, clamped to the real file. */
  startLine: number;
  endLine: number;
  /** Highlight range plus surrounding context; absent if the file was unreadable. */
  excerpt?: CodeExcerpt;
}

export interface WorkflowDetail {
  workflowId: string;
  steps: WorkflowStep[];
}

/* ------------------------------------------------------------------ *
 * Structural guards — used on API responses (client) and on persisted
 * snapshot content (server), where the data crossed a trust boundary.
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isStrArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isStr);
}

function isStop(value: unknown): value is WorkflowStop {
  return isRecord(value) && isStr(value.fileId) && (value.symbol === undefined || isStr(value.symbol));
}

function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  return (
    isRecord(value) &&
    isStr(value.id) &&
    isStr(value.title) &&
    isStr(value.goal) &&
    isStr(value.trigger) &&
    Array.isArray(value.route) &&
    value.route.every(isStop)
  );
}

function isFeature(value: unknown): value is GuideFeature {
  return isRecord(value) && isStr(value.title) && isStr(value.summary) && isStrArray(value.files);
}

function isReadingStop(value: unknown): value is ReadingStop {
  return isRecord(value) && isStr(value.fileId) && isStr(value.why);
}

export function isRepoGuide(value: unknown): value is RepoGuide {
  return (
    isRecord(value) &&
    isStr(value.identity) &&
    isStr(value.dataFlow) &&
    Array.isArray(value.workflows) &&
    value.workflows.every(isWorkflowSummary) &&
    Array.isArray(value.features) &&
    value.features.every(isFeature) &&
    Array.isArray(value.readingPath) &&
    value.readingPath.every(isReadingStop)
  );
}

function isExcerpt(value: unknown): value is CodeExcerpt {
  return isRecord(value) && isInt(value.startLine) && isStrArray(value.lines);
}

function isStep(value: unknown): value is WorkflowStep {
  return (
    isRecord(value) &&
    isStr(value.fileId) &&
    isStr(value.title) &&
    isStr(value.narration) &&
    isInt(value.startLine) &&
    isInt(value.endLine) &&
    (value.payload === undefined || isStr(value.payload)) &&
    (value.symbol === undefined || isStr(value.symbol)) &&
    (value.excerpt === undefined || isExcerpt(value.excerpt))
  );
}

export function isWorkflowDetail(value: unknown): value is WorkflowDetail {
  return (
    isRecord(value) &&
    isStr(value.workflowId) &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(isStep)
  );
}
