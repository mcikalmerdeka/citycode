import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as guidePost } from "../app/api/guidance/route";
import { POST as workflowPost } from "../app/api/guidance/workflow/route";
import { rememberGuide, resetStoresForTests, storeGraph } from "../lib/llm/graphCache";
import { resetLlmClientCacheForTests } from "../lib/llm/client";
import type { RepoGuide, WorkflowDetail } from "../lib/guidance/types";
import type { CodeGraph } from "../lib/types";

/* Mock only the network boundary: the two LLM calls return canned data or
 * throw, so route tests are deterministic and offline. */
const GUIDE: RepoGuide = {
  identity: "generated identity",
  workflows: [
    {
      id: "run-it",
      title: "Run it",
      goal: "Do the thing",
      trigger: "A request arrives",
      route: [{ fileId: "src/a.ts" }, { fileId: "src/b.ts" }],
    },
  ],
  features: [],
  readingPath: [],
  dataFlow: "",
};

const DETAIL: WorkflowDetail = {
  workflowId: "run-it",
  steps: [
    { fileId: "src/a.ts", title: "Receive", narration: "It arrives.", startLine: 1, endLine: 2 },
    { fileId: "src/b.ts", title: "Handle", narration: "It is handled.", startLine: 1, endLine: 1 },
  ],
};

const CUSTOM = {
  id: "how-does-it-work",
  title: "How does it work",
  goal: "Explains it",
  trigger: "You ask",
  route: [{ fileId: "src/a.ts" }, { fileId: "src/b.ts" }],
  question: "How does it work?",
};

vi.mock("../lib/llm/guidePrompts", () => ({
  generateRepoGuide: vi.fn(async () => ({ guide: GUIDE })),
  traceWorkflow: vi.fn(async () => ({ detail: DETAIL })),
  designWorkflow: vi.fn(async () => ({ workflow: CUSTOM })),
}));

import { designWorkflow, generateRepoGuide, traceWorkflow } from "../lib/llm/guidePrompts";
import { POST as askPost } from "../app/api/guidance/ask/route";
import { getCachedGuide } from "../lib/llm/graphCache";
const generate = vi.mocked(generateRepoGuide);
const trace = vi.mocked(traceWorkflow);
const design = vi.mocked(designWorkflow);

function file(id: string) {
  return {
    id,
    path: id,
    loc: 3,
    language: "typescript" as const,
    functions: [],
    externalImports: [],
    unresolvedImports: [],
  };
}

function routeGraph(repoPath: string): CodeGraph {
  return {
    files: [file("src/a.ts"), file("src/b.ts")],
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

/** Run `fn` with an OPENAI_API_KEY configured, restoring the environment after. */
async function withKey(fn: () => Promise<void>): Promise<void> {
  process.env.OPENAI_API_KEY = "test-key";
  resetLlmClientCacheForTests();
  try {
    await fn();
  } finally {
    delete process.env.OPENAI_API_KEY;
    resetLlmClientCacheForTests();
  }
}

beforeEach(() => {
  resetStoresForTests();
  generate.mockImplementation(async () => ({ guide: GUIDE }));
  trace.mockImplementation(async () => ({ detail: DETAIL }));
  design.mockImplementation(async () => ({ workflow: CUSTOM }));
});

afterEach(() => {
  resetStoresForTests();
  vi.clearAllMocks();
});

describe("POST /api/guidance", () => {
  it("400 on malformed JSON", async () => {
    const response = await guidePost(new Request("http://localhost/x", { method: "POST", body: "{oops" }));
    expect(response.status).toBe(400);
  });

  it("400 on missing repoKey and on unknown repoKey", async () => {
    expect((await guidePost(request({}))).status).toBe(400);
    expect((await guidePost(request({ repoKey: "local:E:/nowhere" }))).status).toBe(400);
  });

  it("tier 1: a second request is served from the warm cache with no LLM call", async () => {
    storeGraph(routeGraph("E:/repos/w"));
    const key = "local:E:/repos/w";
    await withKey(async () => {
      const first = await guidePost(request({ repoKey: key }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ guide: GUIDE, cached: false });

      const second = await guidePost(request({ repoKey: key }));
      expect(await second.json()).toEqual({ guide: GUIDE, cached: true });
      expect(generate).toHaveBeenCalledOnce();
    });
  });

  it("503 when the LLM is unconfigured", async () => {
    storeGraph(routeGraph("E:/repos/nl"));
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetLlmClientCacheForTests();
    try {
      const response = await guidePost(request({ repoKey: "local:E:/repos/nl" }));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("OPENAI_API_KEY");
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
      resetLlmClientCacheForTests();
    }
  });

  it("502 when the LLM call (or grounding) throws", async () => {
    storeGraph(routeGraph("E:/repos/f"));
    generate.mockImplementation(async () => {
      throw new Error("CityCode: the model returned an unusable repository guide — try again");
    });
    await withKey(async () => {
      const response = await guidePost(request({ repoKey: "local:E:/repos/f" }));
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: string }).error).toContain("unusable");
    });
  });

  it("tier 3 with an unreadable repoPath: key-file selection is fail-soft, the route still answers", async () => {
    storeGraph(routeGraph("E:/repos/does-not-exist"));
    await withKey(async () => {
      const response = await guidePost(request({ repoKey: "local:E:/repos/does-not-exist" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ guide: GUIDE, cached: false });
    });
  });
});

describe("POST /api/guidance/ask", () => {
  const key = "local:E:/repos/ask";

  function seedGuide(): void {
    storeGraph(routeGraph("E:/repos/ask"));
    rememberGuide(key, "abc123", GUIDE);
  }

  it("400 on bad body, empty or oversized question, unknown repo, or no guide", async () => {
    expect((await askPost(new Request("http://localhost/x", { method: "POST", body: "{oops" }))).status).toBe(400);
    expect((await askPost(request({ question: "q" }))).status).toBe(400);
    seedGuide();
    expect((await askPost(request({ repoKey: key, question: "   " }))).status).toBe(400);
    expect((await askPost(request({ repoKey: key, question: "x".repeat(301) }))).status).toBe(400);
    expect((await askPost(request({ repoKey: "local:E:/nowhere", question: "q" }))).status).toBe(400);
    resetStoresForTests();
    storeGraph(routeGraph("E:/repos/ask"));
    expect((await askPost(request({ repoKey: key, question: "q" }))).status).toBe(400); // no guide yet
  });

  it("adds the demo to the guide's list, and each new question appends another", async () => {
    seedGuide();
    await withKey(async () => {
      const first = await askPost(request({ repoKey: key, question: "How does it work?" }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ workflow: CUSTOM, existing: false });
      expect(getCachedGuide(key, "abc123")!.workflows.map((w) => w.id)).toEqual(["run-it", "how-does-it-work"]);

      design.mockImplementation(async () => ({ workflow: { ...CUSTOM, id: "second", question: "Another?" } }));
      await askPost(request({ repoKey: key, question: "Another?" }));
      expect(getCachedGuide(key, "abc123")!.workflows.map((w) => w.id)).toEqual(["run-it", "how-does-it-work", "second"]);
    });
  });

  it("the same question again returns the existing demo without an LLM call", async () => {
    seedGuide();
    await withKey(async () => {
      await askPost(request({ repoKey: key, question: "How does it work?" }));
      const again = await askPost(request({ repoKey: key, question: "  how DOES it work? " }));
      expect(await again.json()).toEqual({ workflow: CUSTOM, existing: true });
      expect(design).toHaveBeenCalledOnce();
      expect(getCachedGuide(key, "abc123")!.workflows).toHaveLength(2);
    });
  });

  it("the new demo can then be traced like any other", async () => {
    seedGuide();
    await withKey(async () => {
      await askPost(request({ repoKey: key, question: "How does it work?" }));
      const traced = await workflowPost(request({ repoKey: key, workflowId: "how-does-it-work" }));
      expect(traced.status).toBe(200);
    });
  });

  it("503 when unconfigured, 502 when the model fails", async () => {
    seedGuide();
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetLlmClientCacheForTests();
    try {
      expect((await askPost(request({ repoKey: key, question: "q" }))).status).toBe(503);
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
      resetLlmClientCacheForTests();
    }
    design.mockImplementation(async () => {
      throw new Error("CityCode: that question could not be mapped onto files in this repo — try rephrasing it");
    });
    await withKey(async () => {
      const response = await askPost(request({ repoKey: key, question: "q" }));
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: string }).error).toContain("rephrasing");
    });
  });
});

describe("POST /api/guidance/workflow", () => {
  const key = "local:E:/repos/wf";

  function seedGuide(): void {
    storeGraph(routeGraph("E:/repos/wf"));
    rememberGuide(key, "abc123", GUIDE);
  }

  it("400 on malformed JSON and on missing fields", async () => {
    expect((await workflowPost(new Request("http://localhost/x", { method: "POST", body: "{oops" }))).status).toBe(400);
    expect((await workflowPost(request({ workflowId: "run-it" }))).status).toBe(400);
    expect((await workflowPost(request({ repoKey: key }))).status).toBe(400);
  });

  it("400 on an unknown repoKey", async () => {
    expect((await workflowPost(request({ repoKey: "local:E:/nowhere", workflowId: "run-it" }))).status).toBe(400);
  });

  it("400 when the workflow is not in the guide this server holds", async () => {
    seedGuide();
    const response = await workflowPost(request({ repoKey: key, workflowId: "made-up" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("unknown workflow");
    expect(trace).not.toHaveBeenCalled();
  });

  it("400 when no guide exists yet for the repo", async () => {
    storeGraph(routeGraph("E:/repos/wf"));
    expect((await workflowPost(request({ repoKey: key, workflowId: "run-it" }))).status).toBe(400);
  });

  it("traces once, then serves the warm cache (cached=true, no second LLM call)", async () => {
    seedGuide();
    await withKey(async () => {
      const first = await workflowPost(request({ repoKey: key, workflowId: "run-it" }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ detail: DETAIL, cached: false });

      const second = await workflowPost(request({ repoKey: key, workflowId: "run-it" }));
      expect(await second.json()).toEqual({ detail: DETAIL, cached: true });
      expect(trace).toHaveBeenCalledOnce();
    });
  });

  it("503 when the LLM is unconfigured", async () => {
    seedGuide();
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetLlmClientCacheForTests();
    try {
      const response = await workflowPost(request({ repoKey: key, workflowId: "run-it" }));
      expect(response.status).toBe(503);
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
      resetLlmClientCacheForTests();
    }
  });

  it("502 when the trace fails", async () => {
    seedGuide();
    trace.mockImplementation(async () => {
      throw new Error("CityCode: the model returned an unusable workflow trace — try again");
    });
    await withKey(async () => {
      const response = await workflowPost(request({ repoKey: key, workflowId: "run-it" }));
      expect(response.status).toBe(502);
    });
  });
});
