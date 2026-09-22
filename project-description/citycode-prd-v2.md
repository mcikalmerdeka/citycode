# PRD: CityCode — A Living-City Visualization of Codebases

## 1. Summary

CityCode is a personal, local-first tool that turns a codebase — a cloned GitHub repo or a local project folder — into an interactive city. Files become buildings, folders become districts, imports become roads. You can view the current state (HEAD), compare it against the previous commit, or compare it against your uncommitted working-directory changes, the same moment you'd normally run `git diff` before committing. The goal is a fast, intuitive way to see what a codebase looks like and what just changed, without reading a diff line by line.

## 2. Problem Statement

AI coding assistants can generate or modify large amounts of code in minutes — faster than it's practical to read line by line. A raw `git diff` tells you *what* text changed but not *what it means* or *how far it reaches* in the codebase. There's no fast, intuitive way to look at a repo — or at your own uncommitted changes before committing — and get a spatial sense of what exists, what's connected, and what just moved.

## 3. Goals

- Generate a city visualization of a codebase's current state (HEAD) — either a cloned GitHub repo or a local folder.
- Compare HEAD against exactly one previous commit (HEAD~1) — a single-step diff, not a history browser.
- Compare HEAD against uncommitted working-directory changes — mirroring the moment right before a normal `git commit`.
- Let a generated city be saved and reloaded instantly, without re-parsing the repo from scratch.
- Use an LLM (via an OpenAI-compatible endpoint) to generate plain-English explanations of files/functions and of what changed.

## 4. Non-Goals

- **No full git history.** Only two states are ever compared at once: HEAD vs. HEAD~1, or HEAD vs. working directory. No commit browsing, no time-lapse.
- **No database, no migrations, no object storage.** This is a one-time-use-per-repo local tool, not a hosted multi-user service.
- **No separate backend service.** Everything runs inside a single Next.js app.
- **No multi-user or hosting concerns.** Built for personal use, run locally.
- Not a code editor or IDE replacement.
- Not attempting runtime/behavioral visualization (execution tracing).
- Not aiming for full multi-language support at launch — one primary language first.

## 5. Primary User

You — a developer running this locally to understand a repo's structure and to sanity-check your own changes (or an AI agent's changes) before committing or opening a PR. Single-user, local-first, no accounts, no hosting.

## 6. Core Metaphor Mapping

| Code concept | City element |
|---|---|
| File | Building (size = lines of code / complexity) |
| Folder / module | District or neighborhood |
| Core shared utility / config | Power lines, water pipes — cutting one visibly affects many buildings |
| Import / function call | Road connecting buildings; traffic volume = call frequency |
| Entry point (main function) | City hall / downtown core |
| Changed file/function (vs. HEAD~1 or vs. working directory) | Active construction site with a crane |
| Deleted file | Demolished lot / rubble |
| New, uncommitted file | Freshly poured foundation, not yet a full building |
| Deprecated / unused code | Abandoned building |
| Architecture violation (improper coupling) | Zoning violation, flagged in red |

## 7. Key Features

### 7.1 Import
- **GitHub repo URL**: clone the repo locally (current HEAD only — no history walk).
- **Local folder**: point at an existing local project (already-cloned repo, or a project mid-development) and read it directly from disk.

### 7.2 Static City View
- Render the imported repo's current HEAD as a city, for one primary language to start.
- Click-to-inspect: clicking a building/road surfaces a plain-English, LLM-generated explanation of what that file/function does.
- Legend/key always visible so the metaphor is self-explanatory.

### 7.3 Compare Mode — HEAD vs. Previous Commit
- Diff HEAD against HEAD~1 only (one step back, not a history browser).
- Changed files/functions appear as construction sites; deleted files appear as rubble.
- Blast-radius highlighting: anything downstream of a changed file lights up.
- LLM-generated plain-English summary of what changed between the two commits.

### 7.4 Compare Mode — HEAD vs. Working Directory
- Diff HEAD against the current uncommitted state of the working directory — the same information `git status` / `git diff` would show before a commit.
- Same visual treatment as commit-to-commit compare (construction sites, blast radius, LLM summary), but framed as "what am I about to commit."

### 7.5 Save / Reload
- Save a generated city (including its parsed graph and any diff view) to a local file.
- Reloading the same repo/commit checks for a saved snapshot first and loads it instantly instead of re-cloning and re-parsing.

### 7.6 Stretch ideas (not committed, not scoped)
- Health overlays (complexity, dead code) as toggleable layers.
- Exportable city snapshot image for sharing.
- Support for a second/third language.

## 8. User Stories

- As the developer, I want to point CityCode at a repo and see its structure as a city, so I can build a mental map of it quickly.
- As the developer, I want to compare HEAD against the previous commit, so I can sanity-check what a single commit (mine or an AI agent's) actually touched.
- As the developer, I want to see my uncommitted changes visualized before I commit, the same way I'd review a `git diff`, but spatially.
- As the developer, I want to reopen a repo I've already visualized without waiting for it to reparse.

## 9. Success Metrics

Since this is a personal tool, success is subjective and practical rather than metric-driven:
- I actually use it before committing/reviewing AI-generated changes, instead of just reading a raw diff.
- The city view genuinely helps me spot unintended blast radius faster than scanning a diff would.
- Reloading a saved city is meaningfully faster than the first-time generation.

## 10. Design Principles

- **One visual property, one meaning.** Don't overload size, color, and position with multiple overlapping meanings.
- **The two compare modes are the core value**, not the static view — most of the design effort should go there.
- **Every visual element should answer "why should I care," not just "what is this."**
- **Local-first, disposable by default.** No accounts, no server-side persistence beyond a simple local snapshot file you control.
- **Scope by cost, not ambition.** Full history and time-lapse were deliberately cut — they added cost disproportionate to the actual problem being solved.

## 11. Risks & Open Questions

- **Layout stability**: the city's layout should stay consistent between the "before" and "after" of a compare view, so a viewer can tell what moved because of the diff, not because of a layout recalculation.
- **Local folder edge cases**: uncommitted changes may include untracked new files, renames, or deletions — need a clear visual treatment for each.
- **Parsing performance on large repos**: even a single-commit parse can be slow for a very large codebase; may need a size cutoff or a "summarize instead of fully render" fallback.
- **LLM cost/latency**: keep per-node summaries cached locally alongside the saved snapshot, so reloading doesn't re-trigger LLM calls.

## 12. Milestones (suggested)

1. **Proof of concept**: static city render for a small local folder, one language, manual mapping — validate the metaphor before building more.
2. **Import flow**: GitHub URL clone + local folder support.
3. **Compare mode — previous commit**: HEAD vs. HEAD~1 diff visualization.
4. **Compare mode — working directory**: HEAD vs. uncommitted changes.
5. **Save/reload**: local snapshot persistence so repeat views are instant.
