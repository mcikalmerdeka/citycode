# CityCode — Tech Stack & Dependencies Reference

Reference document for build decisions. Versions reflect latest stable releases as of September 2026 — re-check before you start building, since this stack moves fast.

**Architecture note**: this is a single Next.js application — no separate backend service, no database, no cloud infrastructure. Next.js API routes / Server Actions run in Node and have full filesystem and `git` access, which is all this tool needs since it's built to run locally for personal use.

## 1. Runtime Versions

| Runtime | Version | Notes |
|---|---|---|
| Node.js | 24.x (LTS) | Active LTS through Oct 2026. Next.js and all tooling below target this comfortably. |
| Package manager | pnpm or npm | Either is fine for a single-app project; pnpm is faster if you're used to it. |
| Git | system-installed `git` (any recent version) | Required if using `simple-git`, which wraps the real `git` CLI rather than reimplementing it. |

## 2. Core Application

| Layer | Choice | Version | Why |
|---|---|---|---|
| Framework | Next.js | 16.2.x | App Router, Server Actions, and API routes give you everything needed — UI, git operations, parsing, and LLM calls — in one codebase. |
| UI library | React | 19.2.x | Required pairing for Next.js 16 and React Three Fiber 9.x. |
| Language | TypeScript | 5.9.x | One language across the entire app now that there's no separate Python backend. |
| Styling | Tailwind CSS | 4.x | Utility-first; v4's CSS-native engine removes most config overhead. |

## 3. City Rendering

| Layer | Choice | Version | Why |
|---|---|---|---|
| 3D engine | Three.js + React Three Fiber (`@react-three/fiber`) | Three.js latest r1xx + `@react-three/fiber` 9.x | Core rendering engine for buildings/districts/roads. Pairs specifically with React 19. |
| 3D helpers | `@react-three/drei` | latest matching R3F 9 | Camera controls, instancing, text-in-3D, loaders. |
| Client state | Zustand | 5.x | Camera state, selected building, active compare mode, before/after toggle. |
| Data fetching | TanStack Query | 5.x | Manages loading/error state while a repo is being cloned/parsed via a Server Action or API route. |

**Simpler alternative worth considering**: if the 3D engine becomes the slowest part to iterate on, an isometric 2D city (SVG or Canvas, no Three.js) uses the exact same underlying graph data and can validate the metaphor faster. Easy to swap in later since the data model doesn't change.

## 4. Git Operations (replaces the old backend's git layer)

| Task | Tool | Notes |
|---|---|---|
| Clone a GitHub repo (HEAD only, shallow) | `simple-git` | Runs `git clone --depth 1` under the hood — no history download. |
| Read a local folder | Node's built-in `fs`/`path` | Server Action reads directly from a local path you provide — no upload step needed since it's local-first. |
| Diff HEAD vs. HEAD~1 | `simple-git` (`git diff HEAD~1 HEAD --name-status`, then per-file diffs as needed) | Exactly one commit back — never a broader history walk. |
| Diff HEAD vs. working directory | `simple-git` (`git status --porcelain`, `git diff`) | Same information `git diff`/`git status` show before a commit — covers modified, added, deleted, and untracked files. |

`simple-git` is preferred over a pure-JS reimplementation (like `isomorphic-git`) here specifically because you already have `git` installed locally and this tool is meant to run on your machine — no reason to avoid the real CLI.

## 5. Code Parsing

> **Updated 2026-09-24:** Python is now a supported second language — `tree-sitter-python`'s own prebuilt WASM loads alongside TypeScript (same mechanism as the Spike A finding). `.py` files join the walker allowlist; Python imports resolve repo-root-anchored (dotted paths + package `__init__.py`), relative imports from the importer's package; third-party modules are recorded as external. All layers downstream of the parser (layout, scene, compares, snapshots) are language-agnostic and unchanged.
>
> **Updated 2026-09-24 (Phase 7):** three divergence decisions from the original plan. (1) The large-repo size cutoffs live **in code, not env** — `MAX_PARSE_FILES` (1500) / `MAX_TOTAL_LOC` (400k) exported from `lib/parser/buildGraph.ts`; a single-user local tool gains nothing from tunable env vars. (2) The skim fallback is implemented **at the analyze route**: a cold build that crosses the cutoff raises `SkimRequiredError`, which the route catches and auto-retries with `skim: true` — the user never sees a failure, just the summarized city. (3) Stage feedback is **in-band NDJSON streaming** (`lib/progress.ts`, negotiated by the `Accept: application/x-ndjson` header) rather than a polling/job-registry endpoint — one POST runs the whole pipeline, so a single-user local tool needs no job state to expire; requests without the header keep the original single-JSON response byte-for-byte.

| Task | Tool | Notes |
|---|---|---|
| Parse source into an AST / symbol graph | `web-tree-sitter` (WASM build of tree-sitter) | Runs directly inside Node/Next.js, no Python dependency needed. Language grammars (e.g. `tree-sitter-typescript`, `tree-sitter-python`) load as WASM files — from each grammar package's own prebuild, never from `tree-sitter-wasms`. |
| Build the file/function/import graph | Custom logic on top of tree-sitter's parse trees | This becomes the core "graph model" — the shared shape that the static view, both compare modes, and (Phase 6) snapshots render from. Languages today: TypeScript/TSX + Python; grammar already ships for JS if a third language is ever wanted. |

## 6. LLM Layer

> **Updated 2026-09-24 (Phase 3):** the provider was switched from OpenCode's OpenAI-compatible endpoint to the **standard OpenAI endpoint** — OpenCode Go additionally required an `x-opencode-session` header and an active subscription, which wasn't worth the complexity for single-shot summaries. Model is now `gpt-6-luna` (released 2026-09-22) with `reasoning_effort: "medium"`; the only env var needed is `OPENAI_API_KEY`.

| Component | Choice | Notes |
|---|---|---|
| Provider | **Standard OpenAI API** (`api.openai.com`) | Started as OpenCode's OpenAI-compatible endpoint; switched during Phase 3 (see the note above). |
| Model | `gpt-6-luna` | Released 2026-09-22. Reasoning effort **medium** via `reasoning_effort` (Chat Completions). With reasoning ≠ `none`, Chat Completions rejects `temperature`/`top_p` — CityCode omits both, and no token cap is forced (the prompt itself is size-capped). |
| SDK | `openai` npm package | Official SDK against the real OpenAI endpoint — no custom `baseURL` needed anymore. |
| Usage | Two call types | (1) Per-file explanation on click, generated once and cached per `(repoKey, headSha, fileId)` in-memory (Phase 3), persisted into snapshots (Phase 6). (2) One diff-summary call per compare view (Phase 4/5). |

Model/endpoint/effort are pinned **in code** (`lib/llm/client.ts` exports `LLM_MODEL` / `LLM_REASONING_EFFORT`); only the API key comes from env.

Example client setup (as implemented in `lib/llm/client.ts`):
```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.chat.completions.create({
  model: "gpt-6-luna",
  reasoning_effort: "medium",
  messages: [{ role: "user", content: "..." }],
});
```

## 7. Persistence — No Database

| Need | Approach |
|---|---|
| Save a generated city so it doesn't need reparsing | Write the parsed graph + city layout + any cached LLM summaries to a local JSON file, e.g. `.citycode-cache/<repo-name>-<sha>.json`. |
| Reload a previously visualized repo | Check for a matching cache file first (by repo path/URL + current HEAD sha); load it directly if present, skip cloning/parsing/LLM calls entirely. |
| Cache invalidation | Simple: if the current HEAD sha (or working-directory diff hash) doesn't match the cached one, regenerate. |

No Postgres, no Redis, no ORM, no migrations — a gitignored local folder of JSON snapshot files is the entire persistence layer.

## 8. Testing

| Layer | Tooling | Notes |
|---|---|---|
| Parsing/graph logic | Vitest | Worth testing since this is the core correctness-sensitive part. |
| Git diff logic | Vitest, using small throwaway git repos as fixtures | Verify HEAD~1 and working-directory diffs produce the expected file lists. |
| UI/rendering | Optional, light | For a personal tool, manual checking is reasonable; add Playwright only if you find yourself repeatedly re-verifying the same UI flow by hand. |

## 9. Suggested Project Structure

```
citycode/
├── app/                    # Next.js App Router — pages, layouts, API routes/Server Actions
├── components/             # City rendering components (Three.js/R3F scene, UI controls)
├── lib/
│   ├── git/                # simple-git wrappers: clone, diff HEAD~1, diff working directory
│   ├── parser/             # tree-sitter parsing → file/function/import graph model
│   ├── city/                # graph model → city layout (buildings, districts, roads)
│   └── llm/                # OpenCode/GLM client + summary prompts
├── .citycode-cache/         # saved snapshots (gitignored)
├── public/
└── package.json
```

A single flat app, no `backend/`/`frontend/` split needed — everything lives in one Next.js codebase.

## 10. Key Version-Compatibility Notes

- `@react-three/fiber` 9.x requires React 19 — keep them paired if you ever bump one.
- Next.js 16 defaults to Turbopack and expects Node 20+; Node 24 LTS is well ahead of that floor.
- `simple-git` requires `git` to be installed and on `PATH` on whatever machine runs the app — fine for local personal use, would matter if you ever deployed this somewhere without a git binary.
- Since API routes/Server Actions need real filesystem and subprocess access (for `git`), run this with `next dev` or a self-hosted `next start` — not on a serverless platform like Vercel's edge/serverless functions, which won't have persistent local disk or your local repos anyway.

## 11. What to Revisit Before Building

Re-check current versions of Next.js, React, and R3F right before you start — this trio ships often enough that a few months' gap can be a meaningful version bump.
