"use client";

/**
 * CodePeek — the demo's code viewer: the real source around the current
 * step, with the exact lines that are "active" highlighted and scrolled
 * into view. The excerpt comes verbatim from the server's grounded trace
 * (never from the model), so the line numbers shown are the file's own.
 */

import { useEffect, useRef } from "react";

import type { FlowStep } from "@/lib/guidance/flowStore";
import { languageOf, tokenizeLine, type TokenKind } from "@/lib/guidance/syntax";

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "",
  comment: "italic text-[#8A8F98]",
  string: "text-[#2F7D5B]",
  keyword: "text-[#9B4A8F]",
  number: "text-[#B05F2D]",
};

export function CodePeek({ step }: { step: FlowStep }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { excerpt, startLine, endLine } = step;

  // Bring the highlighted block into view whenever the step changes.
  useEffect(() => {
    const box = scroller.current;
    const first = box?.querySelector<HTMLElement>("[data-first-active]");
    if (box === null || box === undefined || first === null || first === undefined) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({
      top: Math.max(0, first.offsetTop - box.clientHeight * 0.28),
      behavior: reduce ? "auto" : "smooth",
    });
  }, [step]);

  if (excerpt === undefined) return null;
  const language = languageOf(step.fileId);
  const isActive = (n: number): boolean =>
    startLine !== undefined && endLine !== undefined && n >= startLine && n <= endLine;

  return (
    <aside aria-label="Code for this step" className="panel flex max-h-full min-h-0 w-full flex-col overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-3 py-2">
        <p className="min-w-0 truncate font-mono text-[11px] text-[var(--ink)]" title={step.fileId}>
          {step.fileId}
        </p>
        {startLine !== undefined && endLine !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] text-[var(--ink-secondary)]">
            L{startLine}–{endLine}
          </span>
        ) : null}
      </header>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto bg-[#FBFAF7] py-2 font-mono text-[11.5px] leading-[1.6]"
      >
        {excerpt.lines.map((text, i) => {
          const n = excerpt.startLine + i;
          const active = isActive(n);
          return (
            <div
              key={n}
              data-first-active={active && n === startLine ? "" : undefined}
              className="flex"
              style={{
                background: active ? "rgba(91,91,214,0.12)" : undefined,
                boxShadow: active ? "inset 2px 0 0 #5B5BD6" : undefined,
              }}
            >
              <span className="w-11 shrink-0 select-none pr-2 text-right text-[var(--ink-secondary)] opacity-60">
                {n}
              </span>
              <span className={`whitespace-pre pr-4 ${active ? "text-[var(--ink)]" : "text-[var(--ink)] opacity-55"}`}>
                {text.length === 0
                  ? " "
                  : tokenizeLine(text, language).map((token, k) => (
                      <span key={k} className={TOKEN_CLASS[token.kind]}>
                        {token.text}
                      </span>
                    ))}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
