import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeGraph } from "../lib/types";
import type { KeyFileSelection } from "../lib/llm/keyFiles";
import { DEFAULT_LLM_MODEL } from "../lib/llm/models";

/* The chat client is faked at the getLlmClient boundary: the factory mock
 * echoes the requested model id, so tests can assert WHICH model Repo
 * Guidance actually sends each call to. */
const llm = vi.hoisted(() => {
  const create = vi.fn();
  return {
    create,
    client: { chat: { completions: { create } } },
    getLlmClient: vi.fn(),
  };
});

vi.mock("../lib/llm/client", () => ({
  LLM_REASONING_EFFORT: "medium",
  getLlmClient: llm.getLlmClient,
}));

import { designWorkflow, generateRepoGuide, traceWorkflow } from "../lib/llm/guidePrompts";

function graph(): CodeGraph {
  return {
    files: [
      { id: "src/a.ts", path: "src/a.ts", loc: 3, language: "typescript", functions: [], externalImports: [], unresolvedImports: [] },
      { id: "src/b.ts", path: "src/b.ts", loc: 3, language: "typescript", functions: [], externalImports: [], unresolvedImports: [] },
    ],
    edges: [],
    headSha: "abc123",
    repoPath: "E:/repos/demo",
    source: "local",
  };
}

const keyFiles: KeyFileSelection = { files: [], droppedByBudget: 0 };

function replyWith(content: unknown): void {
  llm.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

const GUIDE_REPLY = {
  identity: "An identity",
  workflows: [],
  features: [{ title: "Feature", summary: "Does things", files: [] }],
  readingPath: [],
  dataFlow: "Data flows.",
};

const TRACE_REPLY = {
  steps: [
    { file: "src/a.ts", startLine: 1, endLine: 2, title: "Arrive", narration: "It arrives.", payload: "x" },
    { file: "src/b.ts", startLine: 1, endLine: 2, title: "Handle", narration: "It is handled." },
  ],
};

const DEMO_REPLY = {
  title: "Do the thing",
  goal: "It does the thing",
  trigger: "You ask",
  route: [{ file: "src/a.ts" }, { file: "src/b.ts" }],
};

beforeEach(() => {
  llm.getLlmClient.mockImplementation((modelId: string) => ({ client: llm.client, model: modelId }));
  llm.create.mockReset();
});

describe("Repo Guidance model selection (guidePrompts)", () => {
  it("generateRepoGuide requests the chosen model and stamps the guide with it", async () => {
    replyWith(GUIDE_REPLY);
    const { guide } = await generateRepoGuide(graph(), keyFiles, "claude-haiku-5-5");
    expect(llm.getLlmClient).toHaveBeenCalledWith("claude-haiku-5-5");
    expect(llm.create).toHaveBeenCalledOnce();
    expect(llm.create.mock.calls[0]![0]).toMatchObject({ model: "claude-haiku-5-5", reasoning_effort: "medium" });
    expect(guide.model).toBe("claude-haiku-5-5");
  });

  it("generateRepoGuide falls back to the registry default when no model is named", async () => {
    replyWith(GUIDE_REPLY);
    const { guide } = await generateRepoGuide(graph(), keyFiles);
    expect(llm.getLlmClient).toHaveBeenCalledWith(DEFAULT_LLM_MODEL);
    expect(guide.model).toBe(DEFAULT_LLM_MODEL);
  });

  it("traceWorkflow requests the chosen model", async () => {
    replyWith(TRACE_REPLY);
    const graphValue = graph();
    const workflow = { id: "w", title: "W", goal: "g", trigger: "t", route: [{ fileId: "src/a.ts" }, { fileId: "src/b.ts" }] };
    const { detail } = await traceWorkflow(graphValue, workflow, new Map(), "claude-haiku-5-5");
    expect(llm.getLlmClient).toHaveBeenCalledWith("claude-haiku-5-5");
    expect(detail.workflowId).toBe("w");
  });

  it("designWorkflow requests the chosen model", async () => {
    replyWith(DEMO_REPLY);
    const { workflow } = await designWorkflow(graph(), "How does it work?", [], "claude-haiku-5-5");
    expect(llm.getLlmClient).toHaveBeenCalledWith("claude-haiku-5-5");
    expect(workflow.route.map((stop) => stop.fileId)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
