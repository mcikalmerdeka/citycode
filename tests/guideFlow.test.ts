import { afterEach, describe, expect, it } from "vitest";
import { pointAlong, polylineLength } from "../lib/guidance/polyline";
import { languageOf, tokenizeLine } from "../lib/guidance/syntax";
import { buildTimeline, dwellSeconds, easeInOut, locate, stepStartTime, HOP_SECONDS } from "../lib/guidance/timeline";
import { flowClock, tickFlow, useFlowStore, type FlowSpec } from "../lib/guidance/flowStore";

describe("timeline", () => {
  const timeline = buildTimeline(["one two three", "four five six", "seven eight nine"]);

  it("lays steps end to end; the first step has no hop", () => {
    expect(timeline.hops).toEqual([0, HOP_SECONDS, HOP_SECONDS]);
    expect(timeline.starts[0]).toBe(0);
    expect(timeline.starts[1]).toBeCloseTo(timeline.dwells[0]!);
    expect(timeline.total).toBeCloseTo(
      timeline.dwells.reduce((a, b) => a + b, 0) + HOP_SECONDS * 2,
    );
  });

  it("dwell scales with narration length but stays within bounds", () => {
    expect(dwellSeconds("short")).toBe(3.5);
    expect(dwellSeconds("word ".repeat(200))).toBe(9);
    expect(dwellSeconds("word ".repeat(15))).toBeGreaterThan(3.5);
    expect(dwellSeconds("word ".repeat(15))).toBeLessThan(9);
  });

  it("locate reports step, phase and progress, and clamps the playhead", () => {
    const hopMid = timeline.starts[1]! + HOP_SECONDS / 2;
    expect(locate(timeline, 0)).toEqual({ index: 0, phase: "dwell", progress: 0 });
    const hop = locate(timeline, hopMid);
    expect(hop.index).toBe(1);
    expect(hop.phase).toBe("hop");
    expect(hop.progress).toBeCloseTo(0.5);
    const dwell = locate(timeline, timeline.starts[1]! + HOP_SECONDS + timeline.dwells[1]! / 2);
    expect(dwell.index).toBe(1);
    expect(dwell.phase).toBe("dwell");
    expect(dwell.progress).toBeCloseTo(0.5);
    expect(locate(timeline, -5).index).toBe(0);
    expect(locate(timeline, 9999)).toEqual({ index: 2, phase: "dwell", progress: 1 });
  });

  it("stepStartTime lands at the step's start, or where the packet has arrived", () => {
    expect(stepStartTime(timeline, 1, false)).toBe(timeline.starts[1]);
    expect(stepStartTime(timeline, 1, true)).toBeCloseTo(timeline.starts[1]! + HOP_SECONDS);
    expect(stepStartTime(timeline, 99, false)).toBe(timeline.starts[2]);
    expect(stepStartTime(buildTimeline([]), 0, false)).toBe(0);
  });

  it("handles an empty timeline and eases smoothly", () => {
    expect(locate(buildTimeline([]), 3)).toEqual({ index: 0, phase: "dwell", progress: 1 });
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(-1)).toBe(0);
  });
});

describe("polyline", () => {
  const path = [
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 10 },
  ];

  it("measures arc length and walks it", () => {
    expect(polylineLength(path)).toBe(20);
    expect(pointAlong(path, 0)).toEqual({ x: 0, z: 0 });
    expect(pointAlong(path, 0.25)).toEqual({ x: 5, z: 0 });
    expect(pointAlong(path, 0.75)).toEqual({ x: 10, z: 5 });
    expect(pointAlong(path, 1)).toEqual({ x: 10, z: 10 });
    expect(pointAlong(path, 7)).toEqual({ x: 10, z: 10 }); // clamped
  });

  it("degenerate input never throws", () => {
    expect(pointAlong([], 0.5)).toEqual({ x: 0, z: 0 });
    expect(pointAlong([{ x: 3, z: 4 }], 0.5)).toEqual({ x: 3, z: 4 });
    expect(pointAlong([{ x: 1, z: 1 }, { x: 1, z: 1 }], 0.5)).toEqual({ x: 1, z: 1 });
  });
});

describe("syntax tokenizer", () => {
  const kinds = (line: string, lang: "ts" | "py" = "ts") =>
    tokenizeLine(line, lang).map((t) => `${t.kind}:${t.text}`);

  it("colors keywords, strings, numbers and trailing comments", () => {
    expect(kinds('const x = "hi"; // note')).toEqual([
      "keyword:const",
      "plain: x = ",
      'string:"hi"',
      "plain:; ",
      "comment:// note",
    ]);
    expect(kinds("return 42;")).toEqual(["keyword:return", "plain: ", "number:42", "plain:;"]);
  });

  it("does not treat // inside a string as a comment", () => {
    expect(kinds('const u = "http://x";')).toContain('string:"http://x"');
  });

  it("handles Python comments, keywords and block-comment lines", () => {
    expect(kinds("def run(): # go", "py")).toEqual(["keyword:def", "plain: run(): ", "comment:# go"]);
    expect(kinds(" * a doc line")).toEqual(["comment: * a doc line"]);
  });

  it("is safe on odd input and picks the language from the extension", () => {
    expect(tokenizeLine("", "ts")).toEqual([]);
    expect(kinds("'unterminated")).toEqual(["string:'unterminated"]);
    expect(languageOf("a/b/main.py")).toBe("py");
    expect(languageOf("a/b/main.tsx")).toBe("ts");
  });
});

describe("flow store + ticker", () => {
  const spec: FlowSpec = {
    kind: "flow",
    title: "Demo",
    steps: [
      { fileId: "a.ts", title: "A", narration: "one two three" },
      { fileId: "b.ts", title: "B", narration: "four five six" },
    ],
  };

  afterEach(() => {
    useFlowStore.getState().stop();
    useFlowStore.setState({ speed: 1 });
  });

  /** Tick `seconds` of wall time in 0.1s frames (the ticker's per-frame cap). */
  function run(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / 0.1); i++) tickFlow(0.1);
  }

  it("start begins playing at step 0; ignoring an empty demo", () => {
    useFlowStore.getState().start({ ...spec, steps: [] });
    expect(useFlowStore.getState().flow).toBeNull();
    useFlowStore.getState().start(spec);
    const state = useFlowStore.getState();
    expect(state.playing).toBe(true);
    expect(state.index).toBe(0);
    expect(flowClock.t).toBe(0);
  });

  it("the ticker advances the playhead and syncs step/phase when it crosses a boundary", () => {
    useFlowStore.getState().start(spec);
    run(3.4);
    expect(useFlowStore.getState().index).toBe(0);
    run(0.5); // past step 0's dwell → step 1's hop
    expect(useFlowStore.getState().index).toBe(1);
    expect(useFlowStore.getState().phase).toBe("hop");
    run(2); // hop done → dwell
    expect(useFlowStore.getState().phase).toBe("dwell");
  });

  it("speed scales the playhead; a long frame cannot teleport it", () => {
    useFlowStore.getState().start(spec);
    useFlowStore.getState().setSpeed(2);
    tickFlow(0.1);
    expect(flowClock.t).toBeCloseTo(0.2);
    tickFlow(5); // tab was hidden for 5s: capped to one 0.1s frame
    expect(flowClock.t).toBeCloseTo(0.4);
  });

  it("finishes at the end, then play replays from the top", () => {
    useFlowStore.getState().start(spec);
    run(30);
    let state = useFlowStore.getState();
    expect(state.finished).toBe(true);
    expect(state.playing).toBe(false);
    expect(state.index).toBe(1);

    state.togglePlay();
    state = useFlowStore.getState();
    expect(state.finished).toBe(false);
    expect(state.playing).toBe(true);
    expect(state.index).toBe(0);
    expect(flowClock.t).toBe(0);
  });

  it("goToStep lands at the hop start while playing, and where the packet arrived while paused", () => {
    useFlowStore.getState().start(spec);
    const { timeline } = useFlowStore.getState().flow!;
    useFlowStore.getState().goToStep(1);
    expect(flowClock.t).toBeCloseTo(timeline.starts[1]!);
    expect(useFlowStore.getState().phase).toBe("hop");

    useFlowStore.getState().togglePlay(); // pause
    useFlowStore.getState().goToStep(0);
    useFlowStore.getState().goToStep(1);
    expect(flowClock.t).toBeCloseTo(timeline.starts[1]! + HOP_SECONDS);
    expect(useFlowStore.getState().phase).toBe("dwell");
  });

  it("a paused demo does not advance; tick on no demo is a no-op", () => {
    useFlowStore.getState().start(spec);
    useFlowStore.getState().togglePlay();
    run(2);
    expect(flowClock.t).toBe(0);
    useFlowStore.getState().stop();
    expect(tickFlow(0.1)).toBeNull();
  });
});
