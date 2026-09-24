/**
 * Phase 7 pipeline stage feedback — the shared NDJSON contract between
 * /api/analyze (server) and the import form (client).
 *
 * Design notes:
 * - The analyze route's whole pipeline (clone → walk → parse → layout →
 *   save — PRD §7.1–§7.5) runs inside one POST, so stage updates are pushed
 *   IN-BAND as newline-delimited JSON lines before the final result, rather
 *   than through a side-channel polling endpoint. A single-user local tool
 *   gains nothing from a job registry; one streamed response per POST is a
 *   strictly simpler shape with no state to expire.
 * - Backward compatibility is negotiated per-request: only callers that
 *   send `Accept: application/x-ndjson` get the streamed format. Every
 *   other client (the compare bar, the phase 6 route-level tests) keeps the
 *   byte-for-byte single-JSON response the pipeline has always returned —
 *   the compare flow validates its responses with guards that this module
 *   never touches.
 * - Stages are coarse, honest milestones (cloning / walking / parsing /
 *   layout / saving), never per-file ticks, so even a huge repo cannot
 *   flood the stream. All stage text is transient UI state: nothing here is
 *   persisted into snapshots, and the determinism contract is untouched.
 */

/** Coarse pipeline milestones, in request-source order. */
export type AnalysisStage = "cloning" | "walking" | "parsing" | "layout" | "saving" | "loading-snapshot";

/** One in-flight progress event: the stage reached plus a fixed detail note. */
export interface ProgressLine {
  type: "progress";
  stage: AnalysisStage;
  /** Human-readable, stable-detail note (e.g. "1,234 files") — no timings. */
  detail?: string;
}

/** The terminal failure line — mirrors the 400 { error } body of the JSON path. */
export interface ErrorLine {
  type: "error";
  error: string;
}

/** The final response line — the exact object the JSON path returns. */
export interface ResultLine {
  type: "result";
  result: Record<string, unknown>;
}

export type AnalyzeNdjsonLine = ProgressLine | ErrorLine | ResultLine;

/** Header the client sends to opt into streaming (see the module JSDoc). */
export const NDJSON_ACCEPT = "application/x-ndjson";

/** Content-Type of a streamed analyze response. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** True when a response Content-Type marks this as a streamable analyze body. */
export function isNdjsonContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && contentType.split(";")[0].trim() === NDJSON_ACCEPT;
}

/** Encode one NDJSON line (compact JSON + "\n") — server side. */
export function encodeNdjsonLine(line: AnalyzeNdjsonLine): string {
  return `${JSON.stringify(line)}\n`;
}

/**
 * Parse one streamed line into a discriminated event, or null when the
 * chunk is not a well-formed line (trailing whitespace / partial JSON —
 * the line reader guarantees whole lines, so this is defensive only).
 */
export function parseNdjsonLine(text: string): AnalyzeNdjsonLine | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (type === "progress" && typeof record.stage === "string") {
    return {
      type: "progress",
      stage: record.stage as AnalysisStage,
      ...(typeof record.detail === "string" && record.detail.length > 0 ? { detail: record.detail } : {}),
    };
  }
  if (type === "error" && typeof record.error === "string") {
    return { type: "error", error: record.error };
  }
  if (type === "result" && typeof record.result === "object" && record.result !== null) {
    return { type: "result", result: record.result as Record<string, unknown> };
  }
  return null;
}

/**
 * Incrementally read a web ReadableStream and yield complete lines
 * (terminators: "\n", possibly preceded by "\r"). Decoding is buffered
 * across chunks, so UTF-8 multibyte characters split by chunk boundaries
 * stay intact. Never used server-side — the browser's response body only.
 */
export async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        yield buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}
