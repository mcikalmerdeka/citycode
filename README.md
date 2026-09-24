# CityCode

CityCode turns a codebase into an interactive 3D city. Files are buildings (height = lines of code, footprint = function count), folders are districts laid out as a squarified treemap, and intra-repo imports are roads between buildings. Point it at a local folder or a GitHub URL and it renders the current state of the code, compares it against the previous commit or your uncommitted working-directory changes, and explains any file in plain English on click.

Local-first and single-user: one Next.js app, no database, no cloud. Everything runs on your machine.

## Features

- **Static view** — the repo as it sits now: buildings sized by lines of code, districts per folder, roads per import edge. Deterministic: the same repo always renders the identical city.
- **Previous commit compare** (HEAD vs. HEAD~1) — modified files become construction sites with a rotating crane, deleted files become rubble, renames draw a cyan moved-marker line from the old spot to the new one, and everything that imports a changed file lights up in red (the blast radius). One LLM-generated plain-English summary of the commit appears alongside.
- **About to commit compare** (HEAD vs. working directory) — the same treatment for uncommitted changes: modified, staged, untracked (rendered as freshly-poured foundations), renamed, and deleted files, with a change summary.
- **Click-to-inspect** — click any building for its path, LOC, functions, importers and importees, plus a plain-English explanation of what the file does, generated once per file and cached.
- **Instant snapshot reload** — every analyzed repo state is saved as a JSON snapshot; reopening it skips clone, parse and LLM calls entirely.
- **Languages** — TypeScript/TSX and Python.

## Prerequisites

- **Node.js 24** (LTS)
- **git** on PATH — needed for GitHub clones and both compare modes. The static view of a local folder works without it.
- **pnpm 10** — npm works too, but pnpm is the tested package manager.

## Environment

CityCode reads a single env var: `OPENAI_API_KEY`. Copy `.env.example` to `.env.local` and fill it in.

**The key is optional.** Without it the city works fully: import, render, compare modes, snapshots. The only things that degrade are the LLM features (file explanations and change summaries), which show a readable "disabled" message instead of text. With a key set, explanations and summaries appear on first click and are cached from then on.

## Getting started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), then paste either a local folder path (e.g. `E:/repos/my-project`) or a GitHub repo URL (`https://github.com/<owner>/<repo>`) into the import form and hit **Build city**.

## Usage walkthrough

**Mode tabs** — above the city, three tabs: *Static* (as the code sits now), *Previous commit* (HEAD vs. HEAD~1), and *About to commit* (HEAD vs. working directory). On a folder that is not a git repository, both compare tabs are disabled with the reason ("not a git repository — compare modes need git history"); the static view is unaffected.

**Legend** — always visible. Color is reserved entirely for compare status and never encodes size or type:

- amber — construction site · modified
- lime — fresh construction · added
- pale slab — foundation · untracked (about to commit)
- grey — rubble · deleted
- cyan line — moved · renamed
- red — blast radius · importer touched

**Inspect panel** — click any building to see its path, LOC, language, function list, importers and importees, plus the "What does this file do?" explanation (first click generates it, repeat clicks are served from cache with a `cached` badge).

## Snapshots

Every successful analysis is auto-saved to `.citycode-cache/snapshots/` (gitignored), one JSON file per repo state. Reopening the same repo state loads instantly: no re-clone, no re-parse, no repeat LLM calls, and previously generated explanations persist. Corrupt or truncated snapshot files are treated as cache misses and silently regenerated. Snapshots older than 7 days are swept (best-effort).

## Large repositories

Repos above 1,500 source files or 400,000 lines of code fall back to a **summarized city**: buildings are sized by lines of code, but per-file functions and import roads are omitted. The UI shows a "summarized" badge and a warning explaining what was left out. This happens automatically, never as a failure, so a huge repo never freezes the browser tab.

## Troubleshooting

- **Missing or incorrect `OPENAI_API_KEY`** — explanations and summaries return a readable 503 message; the city itself keeps working. Check that the key is in `.env.local` and spelled correctly.
- **Compare tabs disabled** — the analyzed folder is not a git repository (no HEAD sha). Static view still works.
- **Bad GitHub URL rejected** — only `https://github.com/<owner>/<repo>` is accepted (with optional `.git`, trailing slash, `www.`). Everything else is rejected before any git call.
- **Permission-denied or too-long paths** — unreadable folders report "permission denied", paths beyond the platform limit report "path is too long", nonexistent folders report "input folder does not exist". Each failure has a specific message, never a raw stack trace.
- **git not on PATH** — GitHub import and both compare modes need the real `git` CLI. Install git and make sure it resolves in your shell.

## Development

```bash
pnpm test   # vitest — unit + acceptance tests
pnpm lint   # eslint
pnpm build  # production build (Turbopack, TypeScript check)
```

Project layout:

- `lib/git/` — simple-git wrappers: local folder walk, GitHub URL validation, shallow clone, commit and workdir diffs
- `lib/parser/` — web-tree-sitter parsing into the shared graph model (files, functions, import edges)
- `lib/city/` — graph → deterministic city layout (squarified treemap)
- `lib/diff/` — diff → change classification + blast radius
- `lib/llm/` — OpenAI client, prompts, in-memory caches
- `lib/snapshot/` — JSON snapshot persistence under `.citycode-cache/snapshots/`
- `lib/progress.ts` — NDJSON stage-feedback contract for `/api/analyze`
