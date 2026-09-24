"use client";

/**
 * ImportForm — the entry point of the app: a local folder path in, a city out.
 *
 * POSTs { source: "local", path } to /api/analyze and hands the validated
 * response to the parent via onSuccess. The response is parsed through
 * structural type guards (no `any`, no blind casts): a malformed body is
 * rejected as an error instead of leaking into the render tree.
 */

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import type { CityLayout } from "@/lib/city/layout";
import type { ChangeSet } from "@/lib/diff/apply";
import type { CodeGraph } from "@/lib/types";

/** Validated shape of a 200 response from POST /api/analyze. */
export interface AnalyzeResponse {
  graph: CodeGraph;
  layout: CityLayout;
  warnings: { path: string; message: string }[];
  /** Stable repo key shared with /api/explain (Phase 3). */
  repoKey: string;
  /** Classified change record — present when the request used mode "prev" (Phase 4). */
  changeSet?: ChangeSet;
}

/* ------------------------------------------------------------------ *
 * Type guards — verify every field the Phase 2 UI actually reads.
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function isNum(value: unknown): value is number {
  return typeof value === "number";
}

function isWarning(value: unknown): value is { path: string; message: string } {
  return isRecord(value) && isStr(value.path) && isStr(value.message);
}

function isSymbolDef(value: unknown): value is { name: string; startLine: number; endLine: number } {
  return (
    isRecord(value) &&
    isStr(value.name) &&
    isNum(value.startLine) &&
    isNum(value.endLine)
  );
}

function isFileNode(value: unknown): value is CodeGraph["files"][number] {
  return (
    isRecord(value) &&
    isStr(value.id) &&
    isStr(value.path) &&
    isNum(value.loc) &&
    (value.language === "typescript" || value.language === "tsx" || value.language === "python") &&
    Array.isArray(value.functions) &&
    value.functions.every(isSymbolDef) &&
    Array.isArray(value.externalImports) &&
    value.externalImports.every(isStr) &&
    Array.isArray(value.unresolvedImports) &&
    value.unresolvedImports.every(isStr)
  );
}

function isImportEdge(value: unknown): value is CodeGraph["edges"][number] {
  return (
    isRecord(value) &&
    isStr(value.fromId) &&
    isStr(value.toId) &&
    (value.symbol === undefined || isStr(value.symbol))
  );
}

function isCodeGraph(value: unknown): value is CodeGraph {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.every(isFileNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isImportEdge) &&
    (value.headSha === undefined || isStr(value.headSha)) &&
    isStr(value.repoPath) &&
    (value.source === "local" || value.source === "github")
  );
}

function isBuilding(value: unknown): value is CityLayout["buildings"][number] {
  return (
    isRecord(value) &&
    isStr(value.fileId) &&
    isNum(value.x) &&
    isNum(value.z) &&
    isNum(value.w) &&
    isNum(value.d) &&
    isNum(value.h)
  );
}

function isDistrict(value: unknown): value is CityLayout["districts"][number] {
  return (
    isRecord(value) &&
    isStr(value.path) &&
    isStr(value.label) &&
    isNum(value.x) &&
    isNum(value.z) &&
    isNum(value.w) &&
    isNum(value.d) &&
    isNum(value.depth)
  );
}

function isRoad(value: unknown): value is CityLayout["roads"][number] {
  return (
    isRecord(value) &&
    isStr(value.fromId) &&
    isStr(value.toId) &&
    Array.isArray(value.points) &&
    value.points.every((point) => isRecord(point) && isNum(point.x) && isNum(point.z))
  );
}

function isCityLayout(value: unknown): value is CityLayout {
  return (
    isRecord(value) &&
    Array.isArray(value.buildings) &&
    value.buildings.every(isBuilding) &&
    Array.isArray(value.districts) &&
    value.districts.every(isDistrict) &&
    Array.isArray(value.roads) &&
    value.roads.every(isRoad) &&
    isStr(value.repoPath)
  );
}

function isNodeChange(value: unknown): value is ChangeSet["changes"][number] {
  return (
    isRecord(value) &&
    isStr(value.fileId) &&
    ["construction", "fresh", "rubble", "moved", "blast"].includes(String(value.status)) &&
    (value.oldPath === undefined || isStr(value.oldPath))
  );
}

function isChangeSet(value: unknown): value is ChangeSet {
  return (
    isRecord(value) &&
    isStr(value.headSha) &&
    isStr(value.baseSha) &&
    Array.isArray(value.changes) &&
    value.changes.every(isNodeChange) &&
    isRecord(value.counts) &&
    isNum(value.counts.modified) &&
    isNum(value.counts.added) &&
    isNum(value.counts.deleted) &&
    isNum(value.counts.renamed)
  );
}

function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  return (
    isRecord(value) &&
    isCodeGraph(value.graph) &&
    isCityLayout(value.layout) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isWarning) &&
    isStr(value.repoKey) &&
    (value.changeSet === undefined || isChangeSet(value.changeSet))
  );
}


/* ------------------------------------------------------------------ */

type ImportMode = "local" | "github";

async function analyze(request: { source: "local"; path: string } | { source: "github"; repoUrl: string }): Promise<AnalyzeResponse> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  // A 400 body is { error }; a network/HTML failure may not parse at all.
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || !isAnalyzeResponse(body)) {
    if (isRecord(body) && isStr(body.error)) {
      throw new Error(body.error);
    }
    throw new Error(`Analysis failed (${response.status})`);
  }
  return body;
}

export function ImportForm({ onSuccess }: { onSuccess: (data: AnalyzeResponse) => void }) {
  const [mode, setMode] = useState<ImportMode>("local");
  const [path, setPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");

  const currentValue = mode === "local" ? path : repoUrl;
  const setValue = mode === "local" ? (value: string) => setPath(value) : (value: string) => setRepoUrl(value);

  const mutation = useMutation({
    mutationFn: analyze,
    onSuccess: (data) => onSuccess(data),
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = currentValue.trim();
    if (trimmed.length === 0 || mutation.isPending) return;
    mutation.mutate(
      mode === "local" ? { source: "local", path: trimmed } : { source: "github", repoUrl: trimmed },
    );
  };

  const pendingLabel = mode === "local" ? "parsing files…" : "cloning repo…";

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-2.5">
      <div className="flex gap-1" role="tablist" aria-label="Import source">
        {(
          [
            ["local", "Local folder"],
            ["github", "GitHub URL"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            disabled={mutation.isPending}
            onClick={() => setMode(value)}
            className={
              mode === value
                ? "flex-1 rounded-md border border-zinc-100 bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-950 disabled:opacity-100"
                : "flex-1 rounded-md border border-zinc-700/80 px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
            }
          >
            {label}
          </button>
        ))}
      </div>
      <label
        htmlFor="import-path"
        className="block font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500"
      >
        {mode === "local" ? "Local folder path" : "GitHub repo URL"}
      </label>
      <input
        id="import-path"
        type="text"
        value={currentValue}
        onChange={(event) => setValue(event.target.value)}
        placeholder={mode === "local" ? "E:/repos/my-project" : "https://github.com/owner/repo"}
        autoComplete="off"
        spellCheck={false}
        disabled={mutation.isPending}
        className="w-full rounded-md border border-zinc-700/80 bg-zinc-900/60 px-2.5 py-1.5 font-mono text-xs text-zinc-200 transition-colors placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={mutation.isPending || currentValue.trim().length === 0}
        className="w-full rounded-md bg-zinc-100 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {mutation.isPending ? pendingLabel : "Build city"}
      </button>
      {mutation.isError && mutation.error ? (
        <p role="alert" className="text-xs leading-relaxed text-red-400">
          {mutation.error.message}
        </p>
      ) : null}
    </form>
  );
}
