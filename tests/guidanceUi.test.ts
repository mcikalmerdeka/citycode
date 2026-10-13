import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_LLM_MODEL, LLM_MODELS } from "../lib/llm/models";
import { ModelPicker } from "../components/ui/GuidanceSections";

/* Same verification strategy as ui-restyle.test.ts: the vitest suite runs in
 * a node environment with no @testing-library, so presentational pieces are
 * rendered statically and the modal's data wiring is asserted on source. */

const modalSource = readFileSync(path.join(process.cwd(), "components/ui/GuidanceModal.tsx"), "utf8");

function picker(overrides: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  return createElement(ModelPicker, {
    models: LLM_MODELS,
    selected: DEFAULT_LLM_MODEL,
    onSelect: () => {},
    busy: false,
    error: null,
    regenerate: false,
    onConfirm: () => {},
    onCancel: undefined,
    ...overrides,
  });
}

/** renderToStaticMarkup escapes apostrophes as &#x27; — normalize for content assertions. */
function decodeEntities(html: string): string {
  return html.replace(/&#x27;/g, "'");
}

describe("ModelPicker markup", () => {
  it("renders every registry model as a card with its provider, plus a generate button", () => {
    const html = decodeEntities(renderToStaticMarkup(picker()));
    for (const model of LLM_MODELS) {
      expect(html).toContain(model.label);
      expect(html).toContain(model.provider);
      expect(html).toContain(model.blurb);
    }
    expect(html).toContain("Generate");
  });

  it("marks the preselected model with aria-pressed and the others as released", () => {
    const html = renderToStaticMarkup(picker({ selected: "claude-haiku-5-5" }));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("disables everything while generating and surfaces route errors", () => {
    const html = decodeEntities(renderToStaticMarkup(picker({ busy: true, error: "ANTHROPIC_API_KEY is not set" })));
    expect((html.match(/disabled(?==|>| )/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain("ANTHROPIC_API_KEY is not set");
    expect(html).toContain("alert");
  });

  it("in regenerate mode the confirm button says Regenerate and a Back affordance exists", () => {
    const html = renderToStaticMarkup(picker({ regenerate: true, onCancel: () => {} }));
    expect(html).toContain("Regenerate");
    expect(html).toContain("Back");
  });
});

describe("GuidanceModal wiring (source assertions)", () => {
  it("probes cache-only before generating, so a cached guide skips the picker", () => {
    expect(modalSource).toContain('queryKey: ["guide-probe", repoKey]');
    expect(modalSource).toContain("{ repoKey, probe: true }");
  });

  it("sends the session model with the guide, trace, and ask requests", () => {
    expect(modalSource).toContain("fetchGuide(repoKey, modelId)");
    expect(modalSource).toContain("postForData(\"/api/guidance/workflow\", { repoKey, workflowId, model }");
    expect(modalSource).toContain("{ repoKey, question, model }");
  });

  it("names the generating model on the chip and defaults the picker to the shared default model", () => {
    expect(modalSource).toContain("DEFAULT_LLM_MODEL");
    expect(modalSource).toContain("guideModelId");
  });
});
