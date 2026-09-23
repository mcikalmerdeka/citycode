import { describe, expect, it } from "vitest";
import { LlmConfigError, getLlmClient, resetLlmClientCacheForTests } from "../lib/llm/client";
import {
  getCachedSummary,
  isExplained,
  rememberSummary,
} from "../lib/llm/graphCache";
import { buildExplainUserPrompt, EXPLAIN_SYSTEM_PROMPT } from "../lib/llm/prompts";
import type { CodeGraph, FileNode } from "../lib/types";

/* ------------------------------------------------------------------ *
 * LLM config (client.ts) — error path only; no network in unit tests.
 * ------------------------------------------------------------------ */

describe("LLM client configuration", () => {
  it("throws LlmConfigError when OPENAI_API_KEY is missing", () => {
    resetLlmClientCacheForTests();
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => getLlmClient()).toThrow(LlmConfigError);
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
      resetLlmClientCacheForTests();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Graph store + summary cache (graphCache.ts)
 * ------------------------------------------------------------------ */

function fakeGraph(): CodeGraph {
  return {
    files: [
      {
        id: "src/a.ts",
        path: "src/a.ts",
        loc: 12,
        language: "typescript",
        functions: [{ name: "f", startLine: 1, endLine: 3 }],
        externalImports: [],
        unresolvedImports: [],
      },
    ],
    edges: [{ fromId: "src/b.ts", toId: "src/a.ts", symbol: "f" }],
    headSha: "abc123",
    repoPath: "E:/repos/demo",
    source: "local",
  };
}

describe("summary cache", () => {
  const key = "local:E:/repos/demo";
  const sha = "abc123";
  const file = "src/a.ts";

  it("uniform state: unknown entries are misses, remembered entries hit, headSha participates", () => {
    expect(isExplained(key, sha, file)).toBe(false);
    rememberSummary(key, sha, file, "does things");
    expect(isExplained(key, sha, file)).toBe(true);
    expect(getCachedSummary(key, sha, file)).toBe("does things");

    // A new HEAD is a different explanation context
    expect(isExplained(key, "def456", file)).toBe(false);
    // And undefined headSha (non-git) is its own key
    rememberSummary(key, undefined, file, "nogit version");
    expect(getCachedSummary(key, undefined, file)).toBe("nogit version");
  });
});

/* ------------------------------------------------------------------ *
 * Prompt building (prompts.ts)
 * ------------------------------------------------------------------ */

describe("explain prompts", () => {
  it("includes path, size, functions, and both link directions", () => {
    const graph: CodeGraph = fakeGraph();
    const file: FileNode = graph.files[0];
    const prompt = buildExplainUserPrompt(graph, file);
    expect(prompt).toContain("File path: src/a.ts");
    expect(prompt).toContain("Lines of code: 12");
    expect(prompt).toContain("f (lines 1-3)");
    expect(prompt).toContain("Imported by: src/b.ts");
    expect(prompt).toContain("Imports (repo-internal): (none)");
  });

  it("caps long lists in the prompt", () => {
    const graph = fakeGraph();
    const file: FileNode = {
      ...graph.files[0],
      functions: Array.from({ length: 60 }, (_, i) => ({
        name: `fn${i}`,
        startLine: i + 1,
        endLine: i + 2,
      })),
      externalImports: [],
    };
    const prompt = buildExplainUserPrompt(graph, file);
    expect(prompt).toContain("+20 more"); // 60 functions − 40 shown = "+20 more"
    expect(prompt).not.toContain("fn59");
  });

  it("has a plain-English system prompt without markdown demands", () => {
    expect(EXPLAIN_SYSTEM_PROMPT).toContain("plain English");
  });
});
