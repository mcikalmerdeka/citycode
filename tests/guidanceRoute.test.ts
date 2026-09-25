import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/guidance/route";
import { storeGraph, resetStoresForTests } from "../lib/llm/graphCache";
import { resetLlmClientCacheForTests } from "../lib/llm/client";
import type { CodeGraph } from "../lib/types";

/* Mock only the network boundary: generateRepoGuidance returns canned text
 * or throws, so route tests are deterministic and offline. */
vi.mock("../lib/llm/prompts", () => ({
  generateRepoGuidance: vi.fn(async () => ({ guide: "generated guide" })),
}));

import { generateRepoGuidance } from "../lib/llm/prompts";
const generate = vi.mocked(generateRepoGuidance);

function routeGraph(repoPath: string): CodeGraph {
  return {
    files: [
      {
        id: "src/a.ts",
        path: "src/a.ts",
        loc: 3,
        language: "typescript",
        functions: [],
        externalImports: [],
        unresolvedImports: [],
      },
    ],
    edges: [],
    headSha: "abc123",
    repoPath,
    source: "local",
  };
}

function request(body: unknown): Request {
  return new Request("http://localhost:3000/api/guidance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStoresForTests();
  generate.mockImplementation(async () => ({ guide: "generated guide" }));
});

afterEach(() => {
  resetStoresForTests();
  vi.restoreAllMocks();
});

describe("POST /api/guidance", () => {
  it("400 on malformed JSON", async () => {
    const response = await POST(new Request("http://localhost/x", { method: "POST", body: "{oops" }));
    expect(response.status).toBe(400);
  });

  it("400 on missing repoKey and on unknown repoKey", async () => {
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ repoKey: "local:E:/nowhere" }))).status).toBe(400);
  });

  it("tier 1: warm guidance cache answers cached=true with no LLM call", async () => {
    const graph = routeGraph("E:/repos/w");
    storeGraph(graph);
    const key = "local:E:/repos/w";
    // First request generates (tier 3), so the LLM must be configured.
    process.env.OPENAI_API_KEY = "test-key";
    resetLlmClientCacheForTests();
    try {
      const first = await POST(request({ repoKey: key }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ guide: "generated guide", cached: false });

      const second = await POST(request({ repoKey: key }));
      expect(await second.json()).toEqual({ guide: "generated guide", cached: true });
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      delete process.env.OPENAI_API_KEY;
      resetLlmClientCacheForTests();
    }
  });

  it("503 when LLM is unconfigured", async () => {
    storeGraph(routeGraph("E:/repos/nl"));
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetLlmClientCacheForTests();
    try {
      const response = await POST(request({ repoKey: "local:E:/repos/nl" }));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("OPENAI_API_KEY");
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
      resetLlmClientCacheForTests();
    }
  });

  it("502 when the LLM call throws", async () => {
    storeGraph(routeGraph("E:/repos/f"));
    process.env.OPENAI_API_KEY = "test-key";
    resetLlmClientCacheForTests();
    generate.mockImplementation(async () => {
      throw new Error("CityCode: the model returned an empty repository guide");
    });
    try {
      const response = await POST(request({ repoKey: "local:E:/repos/f" }));
      expect(response.status).toBe(502);
    } finally {
      delete process.env.OPENAI_API_KEY;
      resetLlmClientCacheForTests();
    }
  });

  it("tier 3 with an unreadable repoPath: keyFiles is fail-soft, route still answers", async () => {
    // repoPath never exists on disk — selectKeyFiles catches every read
    // failure and returns an empty selection; the route must still answer.
    storeGraph(routeGraph("E:/repos/does-not-exist"));
    process.env.OPENAI_API_KEY = "test-key";
    resetLlmClientCacheForTests();
    try {
      const response = await POST(request({ repoKey: "local:E:/repos/does-not-exist" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ guide: "generated guide", cached: false });
    } finally {
      delete process.env.OPENAI_API_KEY;
      resetLlmClientCacheForTests();
    }
  });
});
