"use client";

/**
 * DemoPlayer — the guided demo's control surface, docked over the stage
 * while a demo (or reading tour) is active: the current step's title, file,
 * line range and plain-English narration, a segmented timeline (click a
 * segment to jump), play/pause, step, speed, camera-follow and code toggles,
 * and the code viewer beside it.
 *
 * It owns no playback state — that lives in lib/guidance/flowStore.ts, ticked
 * by the scene overlay. This component only renders the discrete state and
 * dispatches actions. The one continuous thing, the timeline fill, is driven
 * by a requestAnimationFrame loop that writes straight to the DOM (no React
 * state), so playing never re-renders the player.
 */

import { useEffect, useRef, type ReactNode } from "react";

import { FLOW_SPEEDS, flowClock, useFlowStore } from "@/lib/guidance/flowStore";
import { useCityStore } from "@/lib/store";

import { CodePeek } from "./CodePeek";

const ACCENT = "#5B5BD6";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

const PlayIcon = () => (
  <Icon>
    <path d="M4 2.5v11l9-5.5z" />
  </Icon>
);
const PauseIcon = () => (
  <Icon>
    <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
  </Icon>
);
const PrevIcon = () => (
  <Icon>
    <path d="M3 2.5h2v11H3zM13 2.5v11L6 8z" />
  </Icon>
);
const NextIcon = () => (
  <Icon>
    <path d="M11 2.5h2v11h-2zM3 2.5v11L10 8z" />
  </Icon>
);
const ReplayIcon = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.5v3h3" />
  </svg>
);
const GuideIcon = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" />
    <circle cx="8" cy="11.6" r=".5" fill="currentColor" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" />
  </svg>
);

/**
 * Drives the timeline segments' fill from the playhead each frame, straight
 * on the DOM. Returns the ref list the segments register themselves in.
 */
function useSegmentFill(count: number) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const { flow } = useFlowStore.getState();
      if (flow !== null) {
        bars.current.forEach((bar, i) => {
          if (bar === null) return;
          const length = (flow.timeline.hops[i] ?? 0) + (flow.timeline.dwells[i] ?? 0);
          const fraction = length > 0 ? (flowClock.t - (flow.timeline.starts[i] ?? 0)) / length : 1;
          bar.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction))})`;
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [count]);
  return bars;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  );
}

export function DemoPlayer({
  onOpenGuide,
  keysEnabled,
}: {
  onOpenGuide: () => void;
  /** False while another overlay (the guide) owns the keyboard. */
  keysEnabled: boolean;
}) {
  const flow = useFlowStore((state) => state.flow);
  const index = useFlowStore((state) => state.index);
  const phase = useFlowStore((state) => state.phase);
  const playing = useFlowStore((state) => state.playing);
  const finished = useFlowStore((state) => state.finished);
  const speed = useFlowStore((state) => state.speed);
  const follow = useFlowStore((state) => state.follow);
  const showCode = useFlowStore((state) => state.showCode);
  const { togglePlay, goToStep, setSpeed, toggleFollow, toggleCode, stop } = useFlowStore.getState();
  const requestFocus = useCityStore((state) => state.requestFocus);
  const requestFrame = useCityStore((state) => state.requestFrame);
  const bars = useSegmentFill(flow?.steps.length ?? 0);

  // Camera follows the demo: frame both ends while the packet travels, then
  // close in on the building it lands at.
  useEffect(() => {
    if (!follow || flow === null) return;
    const step = flow.steps[index];
    if (step === undefined) return;
    const previous = index > 0 ? flow.steps[index - 1] : undefined;
    if (phase === "hop" && previous !== undefined && previous.fileId !== step.fileId) {
      requestFrame([previous.fileId, step.fileId]);
    } else {
      requestFocus(step.fileId);
    }
  }, [flow, index, phase, follow, requestFocus, requestFrame]);

  useEffect(() => {
    if (!keysEnabled) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const state = useFlowStore.getState();
      if (state.flow === null) return;
      const last = state.flow.steps.length - 1;
      if (event.key === "ArrowRight") {
        if (state.index < last) state.goToStep(state.index + 1);
      } else if (event.key === "ArrowLeft") {
        if (state.index > 0) state.goToStep(state.index - 1);
      } else if (event.key === " ") {
        // On a focused button Space already clicks it — don't also toggle.
        if (event.target instanceof HTMLElement && event.target.closest("button, a")) return;
        event.preventDefault();
        state.togglePlay();
      } else if (event.key === "Escape") {
        state.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysEnabled]);

  if (flow === null) return null;
  const step = flow.steps[Math.min(index, flow.steps.length - 1)]!;
  const last = flow.steps.length - 1;
  const range =
    step.startLine !== undefined && step.endLine !== undefined ? ` · L${step.startLine}–${step.endLine}` : "";
  const hasCode = flow.kind === "flow" && step.excerpt !== undefined;
  const nextSpeed = FLOW_SPEEDS[(FLOW_SPEEDS.indexOf(speed) + 1) % FLOW_SPEEDS.length]!;

  return (
    <>
      {hasCode && showCode ? (
        <div className="pointer-events-auto absolute right-3.5 top-16 z-30 flex max-h-[calc(100%-19rem)] w-[min(30rem,40%)] flex-col">
          <CodePeek step={step} />
        </div>
      ) : null}

      <section
        aria-label="Guided demo player"
        className="panel absolute bottom-4 left-1/2 z-30 w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 overflow-hidden"
      >
        <header className="flex items-start gap-3 px-4 pt-3">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">
              {flow.kind === "flow" ? "Guided demo" : "Reading tour"} · step {index + 1} of {flow.steps.length}
              {finished ? " · finished" : ""}
            </p>
            <h3 className="mt-0.5 truncate text-[13px] font-semibold text-[var(--ink)]">{flow.title}</h3>
          </div>
          <button
            type="button"
            onClick={onOpenGuide}
            title="Back to the guide"
            aria-label="Open the repo guide"
            className="focus-ring rounded-full p-1.5 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
            <GuideIcon />
          </button>
          <button
            type="button"
            onClick={stop}
            title="Exit the demo (Esc)"
            aria-label="Exit the demo"
            className="focus-ring rounded-full p-1.5 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-[6.25rem] px-4 pt-2.5" aria-live="polite">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[11px] font-semibold text-white"
              style={{ background: ACCENT }}
            >
              {index + 1}
            </span>
            <p className="min-w-0 truncate text-[13px] font-semibold text-[var(--ink)]">{step.title}</p>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--ink-secondary)]" title={step.fileId}>
            {step.fileId}
            {range}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink)]">{step.narration}</p>
          {step.payload !== undefined && index < last ? (
            <p className="mt-1.5 text-[11px] text-[var(--ink-secondary)]">
              <span className="eyebrow mr-1.5">hands off</span>
              {step.payload}
            </p>
          ) : null}
        </div>

        <div className="flex gap-1 px-4 pt-2" role="group" aria-label="Steps">
          {flow.steps.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goToStep(i)}
              title={`${i + 1}. ${s.title}`}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              aria-current={i === index ? "step" : undefined}
              className="focus-ring relative h-4 flex-1"
            >
              <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--border)]">
                <span
                  ref={(el) => {
                    bars.current[i] = el;
                  }}
                  className="block h-full origin-left rounded-full"
                  style={{ background: ACCENT, transform: "scaleX(0)" }}
                />
              </span>
            </button>
          ))}
        </div>

        <footer className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-1.5">
          <button
            type="button"
            onClick={() => goToStep(index - 1)}
            disabled={index === 0}
            title="Previous step (←)"
            aria-label="Previous step"
            className="pill-button focus-ring px-2.5! py-2!"
          >
            <PrevIcon />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            title={finished ? "Replay (Space)" : playing ? "Pause (Space)" : "Play (Space)"}
            aria-label={finished ? "Replay the demo" : playing ? "Pause" : "Play"}
            className="pill-button pill-active focus-ring px-3! py-2!"
          >
            {finished ? <ReplayIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            onClick={() => goToStep(index + 1)}
            disabled={index >= last}
            title="Next step (→)"
            aria-label="Next step"
            className="pill-button focus-ring px-2.5! py-2!"
          >
            <NextIcon />
          </button>
          <button
            type="button"
            onClick={() => setSpeed(nextSpeed)}
            title="Playback speed"
            aria-label={`Playback speed ${speed}×, click to change`}
            className="pill-button focus-ring font-mono px-2.5! py-2! text-xs"
          >
            {speed}×
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={toggleFollow}
            aria-pressed={follow}
            title="Let the camera follow the demo"
            className="chip focus-ring px-2.5! py-1.5! text-xs"
          >
            Follow camera
          </button>
          {flow.kind === "flow" ? (
            <button
              type="button"
              onClick={toggleCode}
              aria-pressed={showCode}
              title="Show the code for each step"
              className="chip focus-ring px-2.5! py-1.5! text-xs"
            >
              Code
            </button>
          ) : null}
        </footer>
      </section>
    </>
  );
}
