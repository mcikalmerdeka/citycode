import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { POST } from "../app/api/analyze/route";
import {
  NDJSON_ACCEPT,
  encodeNdjsonLine,
  isNdjsonContentType,
  parseNdjsonLine,
  readNdjsonLines,
} from "../lib/progress";
import { cleanup, makeTempDir, writeFiles } from "./helpers/fixtures";
import { resetStoresForTests } from "../lib/llm/graphCache";

/**
 * Phase 7 — pipeline stage feedback. Unit tests for the NDJSON contract
 * (lib/progress.ts) plus route-level integration of the streamed analyze
 * path: coarse progress milestones in order, then the terminal result or
 * error line. The no-Accept-header path keeps the plain-JSON shape that
 * CompareBar and tests/snapshot.test.ts rely on — those tests prove it.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    cleanup(dir);
  }
  dirs.length = 0;
  resetStoresForTests();
});

describe("ndjson line codec", () => {
  it("round-trips progress, error and result lines", () => {
    expect(parseNdjsonLine(encodeNdjsonLine({ type: "progress", stage: "parsing", detail: "3 files" })))
      .toEqual({ type: "progress", stage: "parsing", detail: "3 files" });
    expect(parseNdjsonLine(encodeNdjsonLine({ type: "error", error: "CityCode: boom" })))
      .toEqual({ type: "error", error: "CityCode: boom" });
    expect(parseNdjsonLine(encodeNdjsonLine({ type: "result", result: { repoKey: "k" } })))
      .toEqual({ type: "result", result: { repoKey: "k" } });
  });

  it("is blank-safe and rejects malformed lines", () => {
    expect(parseNdjsonLine("")).toBeNull();
    expect(parseNdjsonLine("  \n")).toBeNull();
    expect(parseNdjsonLine("{not json")).toBeNull();
    expect(parseNdjsonLine("plain text")).toBeNull();
    expect(parseNdjsonLine('{"type":"unknown"}')).toBeNull();
  });

  it("content-type negotiation helper", () => {
    expect(isNdjsonContentType("application/x-ndjson")).toBe(true);
    expect(isNdjsonContentType("application/x-ndjson; charset=utf-8")).toBe(true);
    expect(isNdjsonContentType("application/json")).toBe(false);
    expect(isNdjsonContentType(null)).toBe(false);
    expect(isNdjsonContentType(undefined)).toBe(false);
  });

  it("readNdjsonLines yields complete lines across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"a":1}\n{"b'), encoder.encode('":2}\n')];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const lines: string[] = [];
    for await (const line of readNdjsonLines(body)) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

/* ------------------------------------------------------------------ *
 * /api/analyze — streamed route-level integration
 * ------------------------------------------------------------------ */

const FIXTURE_FILES = [
  { path: "src/a.ts", contents: 'import { b } from "./b";\nexport function alpha() { return b(); }\n' },
  { path: "src/b.ts", contents: "export function beta() { return 1; }\n" },
];

/** POST to the route with the NDJSON Accept header (streaming contract). */
async function analyzeStreamed(dir: string) {
  const request = new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: `${NDJSON_ACCEPT}; q=0.9, application/json`,
    },
    body: JSON.stringify({ source: "local", path: dir }),
  });
  return POST(request);
}

/** POST without the Accept header stays single-JSON (the compat path). */
async function analyzeJson(dir: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "local", path: dir }),
  });
  const response = await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("POST /api/analyze — NDJSON stage stream", () => {
  it("streams ordered milestones then the result line for a fixture repo", async () => {
    const dir = makeTempDir("citycode-prog-");
    dirs.push(dir);
    writeFiles(dir, FIXTURE_FILES);

    const response = await analyzeStreamed(dir);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")?.split(";")[0]).toBe(NDJSON_ACCEPT);
    if (response.body === null) throw new Error("expected a body");

    const stages: string[] = [];
    let result: Record<string, unknown> | undefined;
    for await (const line of readNdjsonLines(response.body)) {
      const event = parseNdjsonLine(line);
      if (event === null) continue;
      if (event.type === "progress") {
        stages.push(event.stage);
        if (event.stage === "parsing") {
          expect(event.detail).toBe("2 files");
        }
      } else if (event.type === "result") {
        result = event.result;
      } else {
        throw new Error(`unexpected error line: ${event.error}`);
      }
    }

    expect(stages).toEqual(["walking", "parsing", "layout", "saving"]);
    expect(result).toBeDefined();
    expect(result?.repoKey).toBeTypeOf("string");
    const graph = result?.graph as { files: unknown[] };
    expect(graph.files).toHaveLength(2);
    expect(result?.skim).toBeUndefined(); // full parse — no skim marker
  }, 60_000);

  it("streams a readable error terminal line for a nonexistent folder", async () => {
    const request = new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: `${NDJSON_ACCEPT}; q=0.9, application/json`,
      },
      body: JSON.stringify({ source: "local", path: path.join(os.tmpdir(), "citycode-definitely-missing") }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    if (response.body === null) throw new Error("expected a body");

    const events: string[] = [];
    let errorLine: string | undefined;
    for await (const line of readNdjsonLines(response.body)) {
      const event = parseNdjsonLine(line);
      if (event === null) continue;
      if (event.type === "error") {
        errorLine = event.error;
      } else {
        events.push(JSON.stringify(event));
      }
    }

    // The "walking" milestone fires before the folder is even inspected —
    // a coarse stage signal, not a claim of success.
    expect(events).toEqual(['{"type":"progress","stage":"walking"}']);
    expect(errorLine).toMatch(/input folder does not exist/);
  }, 60_000);

  it("without the Accept header the JSON path stays byte-compatible", async () => {
    const dir = makeTempDir("citycode-progjson-");
    dirs.push(dir);
    writeFiles(dir, FIXTURE_FILES);

    const first = await analyzeJson(dir);
    expect(first.status).toBe(200);
    expect(first.body.fromCache).toBeUndefined();

    const second = await analyzeJson(dir);
    expect(second.status).toBe(200);
    expect(second.body.fromCache).toBe(true);
    expect(JSON.stringify(second.body.graph)).toBe(JSON.stringify(first.body.graph));
  }, 60_000);
});
