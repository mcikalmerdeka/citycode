# CityCode — Project Plan & Progress Tracker

> **Single source of truth for execution status.**
>
> - Requirements: [`project-description/citycode-prd-v2.md`](./project-description/citycode-prd-v2.md)
> - Architecture & stack decisions: [`project-description/citycode-tech-stack-v2.md`](./project-description/citycode-tech-stack-v2.md) — *treated as the ARCHITECTURE.md for this project*
> - Update this file as work progresses; keep statuses honest.
>
> **Status legend:** ✅ done · 🚧 in progress · ⬜ pending · ⏸️ deferred · ❌ cancelled
>
> Last updated: 2026-09-24 (Phase 6 complete)

---

## Product Summary

CityCode turns a codebase — a GitHub repo URL or a local folder — into an interactive 3D city: files are buildings, folders are districts, imports are roads. It renders the current state (HEAD), compares HEAD vs. HEAD~1, or compares HEAD vs. uncommitted working-directory changes, with LLM-generated plain-English explanations. Local-first, single-user, single Next.js app, no database.

**Core value:** the two compare modes (§7.3, §7.4 of the PRD) — most design effort goes there, not into the static view.

---

## Phase Dependency Map

```
P0 ──→ P1 ──→ P2 ──→ P3 ──→ P4 ──→ P5 ──→ P6 ──→ P7
       │             │      │
       │             │      └── LLM diff-summary needs P3's client
       │             └── click-to-inspect needs P2's selection UI
       └── blast-radius needs P1's import graph + P2's deterministic layout
```

Phases must complete roughly in order; P4's *visual* work could start early but depends on P1/P2 outputs and P3's LLM client for summaries. **No new npm dependencies are required in any phase — everything is already installed** (see `package.json`).

---

## Phase 0 — Project Setup & Technical Validation ✅ (100%)

**Goal:** A verified, building Next.js scaffold with the two highest-risk technical unknowns (tree-sitter-in-Next.js and R3F rendering) proven out before any feature work.

### Completed
- [x] Next.js 16.3.5 scaffold with TypeScript 5, Tailwind CSS 4 (create-next-app)
- [x] All runtime deps installed: `three@0.186`, `@react-three/fiber@9.7`, `@react-three/drei@10.7`, `zustand@5`, `@tanstack/react-query@5`, `simple-git@3.36`, `web-tree-sitter@0.27`, `openai@7.21`
- [x] Dev deps installed: `vitest@5`, `tree-sitter-python`, `tree-sitter-typescript`, `tree-sitter-wasms` (prebuilt WASM grammars)
- [x] pnpm 10.33.2 configured; scripts: `dev`, `build`, `start`, `lint`, `test`, `test:watch`
- [x] `vitest.config.ts` — node env, includes `tests/**/*.test.ts` + `lib/**/*.test.ts`, `@` → project-root alias
- [x] `lib/` skeleton per tech-stack §9: `git/`, `parser/`, `city/`, `llm/` + README describing each layer
- [x] `.env.example` with `OPENCODE_BASE_URL`, `OPENCODE_API_KEY`, `OPENCODE_MODEL` (OpenCode OpenAI-compatible endpoint, GLM 5.3 Flash)
- [x] `.gitignore` covers `/.citycode-cache/`, env files, `other/`
- [x] Verified (2026-09-22): Node **v24.14.1** LTS · pnpm 10.33.2 · git 2.52 — `pnpm test` exit 0, `pnpm lint` clean, `pnpm build` exit 0 (Turbopack, TypeScript check passed)
- [x] **Spike A PASSED** — `web-tree-sitter@0.27` parsed a TS snippet in plain Node: full S-expression tree + `function_declaration` name extraction via `childForFieldName("name")`
- [x] **Spike A2 PASSED** — same parse ran inside a temporary Next.js route handler under a production Turbopack build (`next start` → HTTP 200, `{"ok":true, functionNames:["main"]}`). Turbopack bundling does **not** break WASM loading. Spike route removed afterwards.
- [x] **Spike B PASSED** — temp R3F hello-cube page verified in a live browser (Playwright): WebGL canvas rendered a lit, spinning cube with OrbitControls; console had **0 errors** (only benign notices: React DevTools hint, HMR connected, a Three.js internal `THREE.Clock` deprecation from R3F internals — not an integration issue). Spike page reverted afterwards.

### Spike A finding (⚠️ changes Phase 1 design)
`tree-sitter-wasms@0.1.13` grammars are built with 2023-era tooling (tree-sitter-cli 0.20.x / old emscripten dylink format) and **fail to load** in `web-tree-sitter@0.27` (`getDylinkMetadata` error). The fix, verified empirically: **use each grammar package's own modern `.wasm` prebuild** instead:

| Language | WASM source |
|---|---|
| TypeScript | `node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm` |
| TSX | `node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm` |
| JavaScript | `node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm` (add dep when needed) |
| Python (stretch) | `node_modules/tree-sitter-python/tree-sitter-python.wasm` |

`tree-sitter-wasms` should be dropped in Phase 1 when the parser module lands (it's dead weight; removing it is safe — the only consumer was the discarded spike path).

### Acceptance
1. `pnpm build`, `pnpm lint`, `pnpm test` all pass on a clean checkout
2. Spike A prints a real parse tree for a TS snippet inside the Next.js runtime
3. Spike B shows a rotating cube at `localhost:3000` with a clean dev console

---

## Phase 1 — Shared Graph Model + Local Folder Ingestion ✅ (100%)

**Goal:** Point CityCode at a local folder and get a typed `CodeGraph` (files, functions, import edges) — the single shared shape every view and both compare modes render from.

**Depends on:** Phase 0 (Spike A). **New modules:**

- `lib/types.ts` — the shared graph model types, imported by every layer
- `lib/git/local.ts` — local-folder walker + repo detection + HEAD sha
- `lib/parser/sitter.ts` — web-tree-sitter WASM initialization (singleton)
- `lib/parser/extract.ts` — parse a file → functions + imports
- `lib/parser/resolve.ts` — resolve relative imports to intra-repo graph edges
- `lib/parser/buildGraph.ts` — orchestration: folder → `CodeGraph`
- `tests/fixtures/` — small throwaway repos, created programmatically in tests via `simple-git` (per tech-stack §8; never commit `.git` fixtures)

### Tasks
- [x] Define `CodeGraph` types: `FileNode { id, path, loc, language, functions: SymbolDef[] }`, `SymbolDef { name, startLine, endLine }`, `ImportEdge { fromId, toId, symbol? }`, `CodeGraph { files, edges, headSha?, repoPath, source: "local" | "github" }` — in `lib/types.ts`; plus `FileNode.externalImports` / `FileNode.unresolvedImports` (added fields, diagnostics only)
- [x] `lib/git/local.ts`: recursive folder walk skipping `node_modules`, `.git`, `.next`, `dist`, `build`, and `.citycode-cache`; extension allowlist (`.ts`/`.tsx` only — binaries can't sneak in); HEAD sha via simple-git when the folder is a git repo (static view works for non-git folders — sha stays undefined; also undefined for repos with no commits)
- [x] `lib/parser/sitter.ts`: tree-sitter initialized once per process (`Parser.init({ locateFile })` with absolute core-wasm path — `web-tree-sitter.wasm`, note the filename); TypeScript/TSX grammars load from the grammar packages' own `.wasm` prebuilds (per the Phase 0 Spike A finding); `tree-sitter-wasms` devDep removed (`pnpm remove`, package.json + lockfile updated)
- [x] `lib/parser/extract.ts`: per file, extract function/generator/class-method names + 1-based line spans and import/re-export statements (specifiers + named symbols). `export function` handled (declaration nested inside export_statement); `export ... from` is a dependency edge too
- [x] `lib/parser/resolve.ts`: resolve `./`/`../` imports (fixed candidate order: as-is (.ts/.tsx) → `.ts` → `.tsx` → `/index.ts` → `/index.tsx`) to file ids — these become `ImportEdge`s (one per named symbol + bare edge for default/namespace/side-effect/star, deduped); bare/external imports recorded on the node, never edges; root-escaping `../` recorded as unresolved
- [x] `lib/parser/buildGraph.ts`: walk → parse → resolve → typed graph; deterministic (same folder twice → byte-identical JSON); returns `{ graph, warnings }` with deterministic fixed-message skip warnings; nonexistent/empty folder throws a clear Error
- [x] Windows-path safety: walker + resolver verified against spaces and backslashes (dev machine path has a space); all output ids are forward-slashed POSIX; `repoPath` is the only absolute path (forward-slashed)
- [x] Unit tests (30 across 5 files): main fixture (3 folders, 10 TS files, cross-imports, external imports, git repo → real sha, zero node_modules nodes), resolution variants, external/unresolved handling, edge granularity + dedupe, skip rules, allowlist, Windows spaces, walker determinism, git/non-git/no-commit sha handling, byte-identical determinism, dogfood (CityCode's own `lib/` parses with real edges) — fixtures are programmatic (temp dirs via `fs.mkdtemp` + simple-git, never committed)

### Acceptance
1. ✅ `buildGraph(fixture)` returns every file as a node, every intra-repo import as an edge, zero `node_modules` nodes (asserted in `tests/acceptance.test.ts`)
2. ✅ `pnpm test` green — 30/30 across `tests/{buildGraph,resolve,walker,git,acceptance}.test.ts`
3. ✅ Parsing CityCode's own `lib/` folder completes without error, with real intra-repo edges (dogfood test)
4. ✅ Same folder parsed twice → byte-identical graph JSON (asserted on full `JSON.stringify`)

### Documented Phase 1 limitations (deliberate scope)
- TypeScript/TSX only (JS/Python grammars deferred; Python wasm already present for the stretch)
- Arrow-function consts, named function expressions, dynamic `import()`, `require()` not captured
- tsconfig path aliases (`@/...`) recorded as external, not resolved
- `.js` extension in specifiers (ESM-style) not rewritten to `.ts`

---

## Phase 2 — City Layout + Static 3D View ✅ (100%)

**Goal:** An imported local folder renders as an interactive, deterministic 3D city with districts, buildings sized by code, and roads for imports — this validates the core metaphor (PRD milestone 1).

**Depends on:** Phase 1. **New modules:**

- `lib/city/layout.ts` — `CodeGraph` → `CityLayout` (pure, deterministic function)
- `components/city/CityScene.tsx` — R3F canvas, lighting, camera controls (client component)
- `components/city/Buildings.tsx` — instanced building rendering + raycast picking
- `components/city/Roads.tsx` — import roads at ground level
- `components/city/Legend.tsx` — always-visible metaphor key
- `components/ui/ImportForm.tsx` — local-path input, loading/error states
- `components/ui/InspectPanel.tsx` — selected-building details (no LLM yet)
- `app/api/analyze/route.ts` — POST `{ source, path }` → `{ graph, layout }`
- `lib/store.ts` — Zustand: selected node, compare mode, camera/labels prefs
- `app/page.tsx` / `app/layout.tsx` — replaced scaffold: QueryClientProvider + import form + city view

### Visual encoding contract (one property = one meaning, per PRD §10)
| Visual | Meaning | Never also means |
|---|---|---|
| Building height | Lines of code | — |
| Building footprint | Function/symbol count | — |
| District block | Folder (nested folders = nested blocks) | — |
| Position | Folder structure only | *not* importance — layout must never shift for emphasis |
| Road | Intra-repo import edge | — |
| **Color** | **Reserved entirely for compare status** (Phase 4/5) | Never encode size/type in color |

### Tasks
- [x] `CityLayout` types: `Building { fileId, x, z, w, d, h }`, `District { path, x, z, w, d, label }`, `Road { fromId, toId, points[] }` — in `lib/city/layout.ts` (plus `CityLayoutOptions` with documented defaults and `CityLayout.repoPath`)
- [x] Layout algorithm: **squarified treemap** (Bruls et al. 2000) per folder — chosen over slice-and-dice for bounded aspect ratios, with a total-order sort (area desc, key asc) making input array order irrelevant; buildings placed inside their district; root rect fixed 4:3 landscape, W·D = totalArea, centered on origin. **Decision: no "city hall" boost** — height encodes LOC only (PRD §10 one-property-one-meaning contract outranks the entry-point flourish); footprint carries the symbol-count nod via aspect = √(max(1, fnCount)), clamped into the cell so containment always wins
- [x] `Roads.tsx`: ground-level polylines between connected buildings at y=0.35 (drei `<Line>`, lineWidth 2) — elevated highways deferred as planned
- [x] `CityScene.tsx`: canvas + `OrbitControls` (drei, damping), instanced meshes for buildings (drei `<Instances>`), click → raycast → select via store; `onPointerMissed` deselects; selected building gets a ×1.02 emissive overlay mesh (no z-fighting, base at ground)
- [x] `lib/store.ts` + `InspectPanel.tsx`: selection state (`selectedId`, `compareMode` fixed "static" until Phase 4/5, `showLabels`); panel shows path, LOC, language, function list, importers/importees (deduped, ×N badges, clickable rows)
- [x] `app/api/analyze/route.ts` (`runtime = "nodejs"`, POST `{ source: "local", path }` → `{ graph, layout, warnings }`, everything maps to 400 `{ error }` — never a 500) + typed mutation in `ImportForm` with runtime type guards (no zod, no new deps)
- [x] `ImportForm.tsx`: local-path mode only (GitHub tab arrives in Phase 3, noted in UI)
- [x] `Legend.tsx`: visible in every view mode (always-on overlay: height/footprint/block/road/highlight + "color is reserved for compare mode")
- [x] Response parsing is guard-typed (`isAnalyzeResponse`), page is `"use client"` with `next/dynamic ssr:false` for the R3F canvas; district labels via drei `<Html>` with `pointerEvents: none` (never blocks orbit)

### Acceptance
1. ✅ Import a local folder → city renders: districts labeled (drei Html labels), building height ∝ LOC, roads connect importing→imported (verified in browser: self-repo → 29 buildings, 12 districts, 42 roads)
2. ✅ Click any building → inspect panel updates with that file's details (path/LOC/functions/importers); legend visible (verified in browser; highlight = ×1.02 emissive overlay)
3. ✅ Import the same repo twice → **pixel-identical layout** — `/api/analyze` responses byte-identical across consecutive runs on both `tests/` (6,862 B) and the full self-repo (26,016 B)
4. ✅ Orbit/zoom/pan camera works (OrbitControls, damping); dev console clean — the R3F-internal `THREE.Clock` deprecation warning is surgically filtered via three's `setConsoleFunction` hook (`components/city/threeConsoleFilter.ts`, removal condition: fiber v10 stable); `pnpm build` green (Turbopack, `/api/analyze` registered dynamic)
5. ✅ `pnpm test` 51/51 (21 new layout tests: determinism, containment, sortedness, no-NaN, height/footprint formulas, road endpoints, defensive unsorted-input invariance), `pnpm lint` clean, `npx tsc --noEmit` clean

---

## Phase 3 — GitHub Import + LLM Click-to-Inspect ✅ (100%)

**Goal:** Paste a GitHub URL to shallow-clone-and-render, and clicking any building shows a cached plain-English explanation of that file (PRD milestone 2 + §7.2 click-to-inspect).

**Depends on:** Phase 2. **New modules:**

- `lib/git/clone.ts` — `git clone --depth 1` into `.citycode-cache/clones/<repo-owner>/` (already gitignored), plus cleanup of stale clones
- `lib/git/url.ts` — GitHub URL validation/normalization → repo name
- `lib/llm/client.ts` — `openai` SDK; originally specced with `OPENCODE_*` env vars, implemented against the standard OpenAI endpoint (`OPENAI_API_KEY`; `gpt-6-luna` @ medium reasoning — see the task list below for the change)
- `lib/llm/prompts.ts` — `explainFile()` prompt (path, symbols, LOC, key imports → 2–4 plain sentences)
- `app/api/explain/route.ts` — POST `{ repoKey, fileId }` → `{ summary, cached }`
- `components/ui/ExplainPanel.tsx` — explanation UI with loading / error / content states

### Tasks
- [x] `clone.ts`: shallow clone wrapper (`git clone --depth 1 --single-branch` via simple-git into `.citycode-cache/clones/<owner>/<repo>`; destination always wiped first so re-imports get fresh HEAD; `GIT_TERMINAL_PROMPT=0` prevents hangs; best-effort sweep of sibling clones older than 24h; every failure mapped to one fixed readable message — private/nonexistent are indistinguishable server-side)
- [x] `url.ts`: accepts `https://github.com/<owner>/<repo>` (+ optional `.git`, trailing slash, `www.` — with programmatic tests); every other host rejected for v1
- [x] `llm/client.ts`: single shared client instance (singleton, env read lazily); missing `OPENAI_API_KEY` throws `LlmConfigError`, which `/api/explain` maps to a readable 503 — the city stays fully usable, explanations disabled. **Provider change (2026-09-24):** switched from the OpenCode Go endpoint (which required an `x-opencode-session` header and a subscription) to the standard OpenAI endpoint — model `gpt-6-luna` (released 2026-09-22) at `reasoning_effort: "medium"`; with reasoning ≠ none, Chat Completions rejects `temperature`/`top_p`, so neither is sent
- [x] `prompts.ts`: `buildExplainUserPrompt(graph, file)` — path, LOC, language, function names+spans, importers/importees (deduped), external packages; functions capped at 40, link lists at 20 (+N more); no raw file contents needed
- [x] `app/api/explain/route.ts`: in-memory graph store (`lib/llm/graphCache.ts`) filled by `/api/analyze` keyed `repoKey` (`source:repoPath`, shared via `lib/repoKey.ts`), plus summary cache keyed `(repoKey, headSha, fileId)` — one LLM call per file ever (persisted to snapshots in Phase 6). Failure mapping: 400 bad/unknown key, 503 unconfigured LLM, 502 upstream errors; never a plain 500
- [x] `ExplainPanel.tsx` merged into `InspectPanel` (TanStack Query, auto-fetch on selection change, staleTime∞ + server cache → "cached" badge on repeat clicks); `ImportForm` got Local/GitHub tabs feeding the same `/api/analyze` with `source: "github"` (response now also carries `repoKey`)
- [x] `buildGraph(root, source)` — graphs built from a clone are tagged `source: "github"`; `/api/analyze` clones → walks → parses → lays out, storing the graph server-side for explain

### Acceptance
1. ✅ Paste a GitHub URL (`to-readable-stream.git`, verified 2026-09-24) → shallow clone into `.citycode-cache/clones/sindresorhus/…` → city renders through the identical Phase 1/2 pipeline (`source: "github"`, real sha, files=2)
2. ✅ Click a building → real `gpt-6-luna` explanation appears (first call 3.5s, uncached); clicking the same building again → instant, served from cache (second call 38ms, `cached: true`)
3. ✅ Missing `OPENAI_API_KEY` → the `LlmConfigError` message is surfaced as a readable 503 in the explain section (unit-tested); the city renders and navigates normally
4. ✅ Clone failure (nonexistent repo) → readable error, no crash (verified over HTTP); malformed URL (non-github host) rejected before any git call

---

## Phase 4 — Compare Mode: HEAD vs. HEAD~1 ✅ (100%)

**Goal:** One-step commit-to-commit diff visualization — changed files become construction sites, deleted files rubble, and everything downstream lights up (blast radius), with a stable layout and one LLM change summary (PRD milestone 3).

**Depends on:** Phase 1 (graph edges for blast radius), Phase 2 (deterministic layout — the stability risk is solved by design here), Phase 3 (LLM client). **New modules:**

- `lib/git/diff.ts` — `diffCommits()`: `HEAD~1..HEAD` name-status list + per-file trimmed patches
- `lib/diff/apply.ts` — diff → node classification + transitive reverse-edge closure (blast radius)
- `lib/llm/prompts.ts` — extend with `summarizeDiff()`
- `app/api/analyze/route.ts` — extend with `mode: "static" | "prev" | "workdir"`
- `components/ui/CompareBar.tsx` — mode toggle + diff-summary panel
- Building overlays in `components/city/` — construction site / rubble / foundation treatments + blast-radius tint

### Tasks
- [x] `diff.ts`: name-status (A/M/D/R) + hunk headers & +/- line counts per changed file via `simple-git` (`git diff -M --name-status` + one full plain diff parsed per section — hunks, insertions, deletions; `core.quotepath=off` so paths with spaces parse clean; fixed readable Errors for non-repo / no-commits / single-commit). `lib/git/diff.ts`
- [x] `apply.ts` classification: `modified` → construction site (amber + animated rotating crane marker), `added` → fresh construction (lime), `deleted` → grey rubble slab, `renamed` → cyan moved-marker line from old spot → new position (rename origin sits at the old path's parent district via `parentDistrict()` longest-ancestor fallback). `lib/diff/apply.ts`
- [x] `apply.ts` blast radius: transitive closure over *reverse* import edges from the changed set (BFS on a reverse-adjacency map); all affected, non-changed nodes get the red tint (color reserved for exactly this — Phase 2 encoding contract). `lib/diff/apply.ts`
- [x] **Layout stability (PRD risk §11):** compare renders on the *HEAD graph's* layout — classification never re-lays. `/api/analyze` with `mode:"prev"` + warm `repoKey` re-serves the static run's exact stored graph+layout JSON (no re-parse, byte-identical layout → zero shift by construction); deleted files render rubble at their old district spot (deterministic hashed slot per fileId), never triggering re-layout
- [x] `summarizeDiff()`: one LLM call per compare view — file list (kind + rename old path) + per-file hunk headers (capped 40 files / 5 hunks) → plain-English paragraph; served by the new `POST /api/summarize` with a `(repoKey, headSha)` cache, 503/502 mapping identical to explain
- [x] `CompareBar.tsx` + Zustand `compareMode`: Static / Previous commit / "About to commit" (workdir visibly disabled with a reason until Phase 5); the compare result flows back through the same `onSuccess` path, so entering compare mode causes zero layout shift; top-badge + Legend reflect the mode (compare key rows appear only in compare modes)
- [x] Fixture: programmatic git repo with a crafted commit chain (A modified, B imports A, C imports B, D deleted, E added) → classification + closure unit tests, plus rename detection (`git.mv` → `R` with oldPath), single-commit/non-repo error messages, determinism (byte-identical ChangeSet JSON), and `parentDistrict` fallback tests

### Acceptance
1. ✅ On the fixture: modified file = construction site; B and C (transitive importers) = blast-radius tint; deleted file = rubble; added file = fresh construction (`tests/diff.test.ts`)
2. ✅ LLM summary pipeline renders a readable plain-English paragraph of the commit (`/api/summarize` registered dynamic in the production build; one call per `(repoKey, headSha)`, cache-served on re-toggle)
3. ✅ Toggling static → compare causes **zero layout shift** — compare responses reuse the stored static graph+layout byte-for-byte (determinism gate from Phase 2 holds; verified by test that same graph + diff → identical ChangeSet and by the server cache contract)
4. ✅ `pnpm test` green — 88/88 (11 new across `tests/diff.test.ts`), `pnpm lint` clean, `npx tsc --noEmit` clean, `pnpm build` green (Turbopack; `/api/analyze` + `/api/summarize` dynamic). Browser walkthrough waived this session (per user call — automated gates + unit-level acceptance cover the phase)

### Documented Phase 4 limitations (deliberate scope)
- Deleted files open no blast edges of their own: who-imported-the-deleted-file needs the HEAD~1 graph, which we deliberately don't reconstruct (documented in `apply.ts`)
- Renamed-node detection via `-M` only; copy-overwrite (C rows) treated as renames
- Rubble/marker placement uses the HEAD layout's district lookup with deterministic hashed slots — positions are metaphor, not measurements

### Fix (2026-09-24, user-reported): GitHub clones had no HEAD~1
Phase 3's `--depth 1` clone meant a GitHub import had exactly one commit, so "Previous commit" hit the (correct) single-commit error. Fix: `lib/git/clone.ts` clones at **`--depth 2`** — exactly the two states the compare mode ever diffes (PRD non-goal: no history browser). Verified against a real repo (`mcikalmerdeka/agno-langfuse-travel-planner`: depth-2 clone → full name-status `HEAD~1..HEAD`). Regression test added (`tests/gitClone.test.ts`: 2-commit fixture → clone → `diffCommits` resolves base + changed files); 89/89 green.

---

## Phase 5 — Compare Mode: HEAD vs. Working Directory ✅ (100%)

**Goal:** "What am I about to commit" — the same visual treatment for uncommitted changes, covering modified, staged, untracked, renamed, and deleted files (PRD milestone 4).

**Depends on:** Phase 4 (shares classification + visuals). **New modules:**

- `lib/git/workdir.ts` — `git status --porcelain` + staged (`--cached`) + unstaged diffs → one unified workdir change set; plus a cheap `workdirHash` for cache invalidation later
- Extend `lib/diff/apply.ts` — workdir-specific classifications

### Tasks
- [x] `workdir.ts`: merge staged + unstaged + untracked into a single change set with per-file status — implemented as ONE `git status --porcelain -uall` pass (XY codes already merge index+worktree per file, so no manual staged/unstaged diffing or dedupe) + one `git diff -M HEAD` pass attaching hunk headers/insertions/deletions to tracked files (untracked files have no patch, counts stay 0). `??`/`A`→untracked, any `D`→deleted, index `R`/`C`→renamed ("old -> new" row), else → modified; `!!` (ignored) never appears. `lib/git/workdir.ts`
- [x] Untracked files: they exist on disk — parse them (Phase 1 pipeline) and render as **freshly-poured foundations** (low flat slabs — PRD metaphor, deliberately not-yet-buildings). Two render paths: untracked files already in the captured layout are flattened in place by `Buildings.tsx` (fixed low slab height + pale slate `#e2e8f0`); untracked files added AFTER the city was built (no building in layout) get a foundation slab at their `parentDistrict` slot via `ChangeOverlays.tsx` — same mechanism as rubble
- [x] Renames and deletions in the workdir → same rubble/moved treatment as Phase 4 (`applyWorkdirDiff` in `lib/diff/apply.ts`; shared classification + blast-radius closure refactored with `applyCommitDiff`)
- [x] `workdirHash` = sha-256 of the `status --porcelain -uall` output (feeds Phase 6 cache invalidation), stored on `ChangeSet.workdirHash` for workdir compares only
- [x] `CompareBar.tsx`: third mode *"About to commit"* live; BOTH compare buttons disabled with the reason ("not a git repository — compare modes need git history") when the graph has no HEAD sha; summary fetched with `mode` and cached per workdir hash; counts line shows `untracked` and reads "clean — nothing to commit"
- [x] Edge-case tests (10 new, `tests/workdir.test.ts`): untracked-only, staged-only vs unstaged-only, staged rename (`git.mv`, oldPath recorded, no double delete row), delete, mixed trio (untracked+modified+deleted in one pass with patch details on tracked only), ignored files excluded + clean workdir, non-repo / no-commits readable errors, `applyWorkdirDiff` classification (foundation/construction/rubble + counts + workdirHash), workdir-vs-commit kind divergence (new file = foundation in workdir, invisible to the commit diff), byte-identical determinism

### Acceptance
1. ✅ One untracked + one modified + one deleted file in the fixture → each renders its metaphor (foundation / construction / rubble) — asserted at unit level in `tests/workdir.test.ts`
2. ✅ Clean working directory → empty change set, counts all zero, "clean — nothing to commit" line, zero visual change (hash stable across re-calls, asserted)
3. ✅ Switching modes never shifts the layout — the server answers workdir compares from the stored static analysis verbatim (same reuse path as Phase 4's "prev")
4. ✅ Non-git folder → both compare buttons disabled with the reason, static view unaffected (`isGitRepo` = `graph.headSha !== undefined`)

### Documented Phase 5 limitations (deliberate scope)
- Worktree-only renames (file moved without staging) are not rename-detected by git itself — they read as deleted + untracked, same as raw `git status` would show
- Untracked files created after the city was built place their foundation at a district slot (metaphor, not measurement); re-import to get the exact layout position
- Ignored files are never candidates; merge-state/status rows beyond XY are skipped defensively

---

## Phase 6 — Save / Reload Snapshots ✅ (100%)

**Goal:** Reopening a previously visualized repo loads instantly from a local JSON snapshot — no re-clone, no re-parse, no repeat LLM calls (PRD milestone 5).

**Depends on:** Phase 3 (summaries to persist), Phases 4/5 (change sets to persist). **New modules:**

- `lib/snapshot/schema.ts` — versioned snapshot shape
- `lib/snapshot/save.ts` / `load.ts` — read/write `.citycode-cache/<repo-key>.json`
- `lib/snapshot/key.ts` — cache-key derivation
- `/api/analyze` integration — cache-first path

### Tasks
- [x] Snapshot contents: `{ version, source, repoPathOrUrl, headSha, stateFingerprint, fileStats, graph, layout, warnings, llmSummaries, compareSummaries, createdAt }` (`lib/snapshot/schema.ts`, `SNAPSHOT_VERSION = 1`, structural guard `isSnapshot` for corruption detection). Plus the plan's `changeSet?`/`workdirHash?` fields are deliberately NOT persisted: compare diffs are recomputed live (cheap git calls, and always fresh), while the expensive artifact — the LLM change summary — IS persisted via `compareSummaries` slots (`"prev:<sha>"` / `"workdir:<workdirHash>"`)
- [x] `key.ts`: the snapshot FILE key is `(repoKey, headSha)` — `repoKey` ("local:<forward-slashed abs folder>" / "github:<clone cache path>", both stable across restarts) bundles the normalized source identity, so paths normalize to forward slashes with zero extra work. **Deliberate divergence: mode is not part of the file key** — compare modes reuse the static snapshot's graph + layout verbatim (the Phase 4/5 frozen-layout contract) and recompute only the diff, so there is no per-mode artifact beyond the summary slots. Filenames are `local-<16hex>.json` / `github-<16hex>.json` under `.citycode-cache/snapshots/`
- [x] Save on every successful generate; atomic write (temp file in the same directory → rename, so a crash can never leave a half-valid snapshot); stale-snapshot sweep >7 days (best-effort, mirrors the clone sweep). Saving is best-effort — a failing disk degrades to Phase 5 behavior, never an error
- [x] Load path: `/api/analyze` is now a 3-tier lookup — warm in-memory compare → **snapshot** → cold build. A snapshot hit returns `{ fromCache: true }` and skips clone/parse entirely; the loaded graph + layout are re-hydrated into the in-memory stores so explain/summarize/compare keep working after a server restart. **Freshness beyond the plan's sha-only rule:** local repos get a stat-walk state fingerprint (same skip list + allowlist as the parser, no file contents read) because the static city reflects the ON-DISK tree — uncommitted edits change the city without moving HEAD, and a sha-only key would serve stale cities. GitHub hits additionally require an intact clone whose HEAD matches the snapshot plus a cheap `git ls-remote` probe (a moved remote → fresh clone; a failed probe e.g. offline → intact clone still served, so reloads survive without network)
- [x] Invalidation: local fingerprint mismatch (tree edited, branch switched) or missing/unknown-sha snapshot → regenerate; workdir mode reuses graph + layout and recomputes only the diff (the diff is never persisted, so it is always live)
- [x] Persist `llmSummaries` — `/api/explain` checks the snapshot before calling the LLM and writes fresh summaries back, stamped with the file's `(size, mtimeMs)`; `carryOverSummaries()` keeps only untouched files' summaries across rebuilds (editing one file no longer discards every explanation). `/api/summarize` likewise reads/backs `compareSummaries`. **Reload = zero LLM calls for previously explained files (PRD risk §11, fully closed here)**

### Acceptance
1. ✅ Regenerate the same repo → served from snapshot (`fromCache: true`), graph + layout byte-identical to the cold run (route-level test; the persistent-layout determinism contract makes "visually instant" hold by construction — < 1 s vs multi-second is inherent: no clone, no WASM parse)
2. ✅ New commit → cache invalidated, fresh graph containing the new file (tested: commit fixture file → next analyze misses the snapshot, new headSha snapshot file created)
3. ✅ Reload → clicking a previously-explained file serves the persisted summary with `cached: true` and never reaches the LLM client (persisted-tier read/write is unit-verified; the full dev-log check needs a live `OPENAI_API_KEY` session — optional manual pass)
4. ✅ Corrupt/truncated/zero-byte/wrong-version snapshot files → all detected by parse + structural guard, treated as a cache miss, silently regenerated (tested end-to-end: garbage file → clean regenerate → valid file rewritten)

### Documented Phase 6 decisions (divergences from the plan, with reasons)
- **Mode is not a file-key component** — compares reuse the static snapshot's graph + layout and recompute only cheap diffs; per-mode persistence is the summary slots (`key.ts` header explains this)
- **`changeSet`/`workdirHash` are not persisted** — diff recompute is cheap and always fresh; persisting them would add staleness risk for zero gain
- **Local freshness uses a stat-walk fingerprint, not just the sha** — required so uncommitted edits invalidate the static snapshot (the city is built from disk, not from HEAD)
- **GitHub snapshot hits require an intact matching clone** — diff modes need the real repo on disk to answer; the `ls-remote` probe prevents serving stale snapshots after the remote moved

---

## Phase 7 — Hardening & Polish ⬜ (0%)

**Goal:** Survive real repositories and rough edges — performance fallbacks, error surfaces, and docs that match reality.

**Depends on:** All previous phases. **New modules:** none planned; fixes spread across existing ones.

### Tasks
- [ ] Large-repo guard (PRD risk §11): file/LOC cutoff → "summarize instead of fully render" fallback (district-level rendering, skip per-building detail above the cutoff, show a message)
- [ ] Pipeline stage feedback: cloning → parsing → layout progress indicator (simple loading stages; streaming progress bars only if cheap)
- [ ] Error surfaces: clone failure, path-not-found, permission errors, non-git folder for compare modes — every failure has a human-readable message
- [ ] Cross-platform sweep: Windows paths (spaces, backslashes), long paths, case sensitivity — the dev machine is the first target platform
- [ ] Replace create-next-app `README.md` with real usage docs (prereqs: Node 24, git, pnpm; env setup; run instructions)
- [ ] Update `lib/README.md` placeholders to describe implemented modules
- [ ] Final pass on this plan + decision notes in the tech-stack doc if anything diverged

### Acceptance
1. A real 1k+-file OSS repo either renders in reasonable time or falls back gracefully with a clear message — never a frozen tab
2. Every deliberate failure mode (bad URL, missing key, non-git folder) shows a readable explanation
3. `pnpm build && pnpm test && pnpm lint` green end-to-end
4. A new machine can go from clone to first city render using only the README

---

## Stretch / Deferred (parking lot — do not build without moving into a phase)

| Idea | Status | Source |
|---|---|---|
| Health overlays (complexity, dead-code layers) | ⏸️ | PRD §7.6 |
| Exportable city snapshot image | ⏸️ | PRD §7.6 |
| Second language: Python (grammar already in devDeps) | ✅ Delivered early (2026-09-24, user request) — see "Python support" under Phase 1 completion | PRD §7.6 |
| Zoning-violation detection (red-flagged improper coupling) | ⏸️ | PRD §6 metaphor table — no launch feature requires it |
| 2D isometric SVG/Canvas fallback renderer | ⏸️ | Tech-stack §3 — swap-in only if 3D iteration becomes the bottleneck; data model unchanged |
| Playwright UI tests | ⏸️ | Tech-stack §8 — add only if the same UI flow keeps being re-verified manually |
| Multi-step history / time-lapse | ❌ | PRD §4 Non-Goal — explicitly out |

---

## Risks → Where They're Handled

| PRD §11 Risk | Resolution |
|---|---|
| Layout stability between compare views | Phase 2 (deterministic layout) + Phase 4 (layout frozen from HEAD graph; classification never re-lays) |
| Local-folder edge cases (untracked, renames, deletions) | Phase 5 |
| Parsing performance on large repos | Phase 7 (cutoff + summarize fallback) |
| LLM cost/latency | Phase 3 (in-memory cache) → Phase 6 persisted in snapshots + per-file stat stamping (reload = zero calls; untouched files keep explanations across rebuilds) ✅ |

## Milestone Traceability

| PRD §12 Milestone | Phases |
|---|---|
| 1. Proof of concept (static render, one language) | 1 + 2 |
| 2. Import flow (GitHub URL + local folder) | 3 |
| 3. Compare — previous commit | 4 |
| 4. Compare — working directory | 5 |
| 5. Save/reload | 6 |

## Known Limitations (honest, by design)

- Second language in place: TypeScript/TSX **and Python** (added 2026-09-24): Python absolute imports resolve repo-root-anchored, relative ones from the importer's package; third-party modules recorded as external. Flat/`__init__.py` layouts covered; exotic src-layout path-packages are not
- Only ever two states compared: HEAD vs. HEAD~1, or HEAD vs. workdir — no history browser, ever
- Local-first, single-user, no auth/hosting — running on a machine without `git` on `PATH` breaks clone/diff features (fine for the intended use)
- Snapshot JSON is the entire persistence layer — no DB, no migrations, by design
- Large-repo rendering quality is bounded by the Phase 7 cutoff

## Currently Working On

**Phase 6 — complete (2026-09-24).** Save/reload snapshots fully wired: `lib/snapshot/` (`schema.ts` versioned shape + corruption guard, `key.ts` deterministic `(repoKey, headSha)` filenames under `.citycode-cache/snapshots/`, `fingerprint.ts` stat-walk state fingerprint for local repos, `save.ts` atomic temp→rename writes + `carryOverSummaries`, `load.ts` fail-soft reads), `/api/analyze` 3-tier lookup (warm memory → snapshot → cold build) with store hydration + `fromCache` flag and snapshot save on every generate, GitHub freshness via intact-clone sha + `git ls-remote` probe (`lib/git/clone.ts` gained `parseLsRemoteHead`/`resolveRemoteHead`/`readCloneHeadSha`), and persisted LLM summaries: `/api/explain` and `/api/summarize` read snapshots before any LLM call and write fresh summaries back. 119/119 tests green (18 new in `tests/snapshot.test.ts`, including route-level acceptance tests: byte-identical snapshot reload, commit invalidation, corrupt-file regeneration, cold compare from snapshot), `tsc`/lint/build clean. Browser walkthrough not run this session (per user instruction — no browser automation without permission). Next up: **Phase 7 — hardening & polish** (large-repo guard, stage feedback, error-surface sweep, README).

## Quick Status

| Phase | Description | Status | % |
|---|---|---|---|
| 0 | Setup & technical validation | ✅ | 100 |
| 1 | Graph model + local ingestion | ✅ | 100 |
| 2 | City layout + static 3D view | ✅ | 100 |
| 3 | GitHub import + LLM inspect | ✅ | 100 |
| 4 | Compare: HEAD vs. HEAD~1 | ✅ | 100 |
| 5 | Compare: HEAD vs. workdir | ✅ | 100 |
| 6 | Save / reload snapshots | ✅ | 100 |
| 7 | Hardening & polish | ⬜ | 0 |
