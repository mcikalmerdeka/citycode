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

| Task | Tool | Notes |
|---|---|---|
| Parse source into an AST / symbol graph | `web-tree-sitter` (WASM build of tree-sitter) | Runs directly inside Node/Next.js, no Python dependency needed. Language grammars (e.g. `tree-sitter-typescript`, `tree-sitter-python`) load as WASM files. |
| Build the file/function/import graph | Custom logic on top of tree-sitter's parse trees | This becomes your core "graph model" — the shared shape that both the static view and both compare modes render from. |

## 6. LLM Layer

| Component | Choice | Notes |
|---|---|---|
| Provider | OpenCode's OpenAI-compatible chat endpoint | Custom `baseURL`, not Azure OpenAI. |
| Model | GLM 5.3 Flash | Set via the `model` field in each request. |
| SDK | `openai` npm package | The official OpenAI SDK works against any OpenAI-compatible endpoint — just set `baseURL` to OpenCode's endpoint and pass your API key/config for it. No LangGraph or orchestration framework needed for this — it's single-shot "summarize this file/diff" calls, not a multi-step agent. |
| Usage | Two call types | (1) Per-file/function explanation on click, generated once and cached in the saved snapshot. (2) One diff-summary call per compare view (HEAD vs. HEAD~1, or HEAD vs. working directory). |

Example client setup:
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "<opencode-endpoint-url>",
  apiKey: process.env.OPENCODE_API_KEY,
});

const response = await client.chat.completions.create({
  model: "glm-5.3-flash",
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
