# lib/ — core application logic (see project-description/citycode-tech-stack-v2.md §9)
#
# Each subfolder maps to one layer of the pipeline:
#
#   git/     simple-git wrappers. Implemented: local.ts (deterministic .ts/.tsx
#            folder walk skipping node_modules/.git/.next/dist/build/
#            .citycode-cache; git repo detection + HEAD sha via simple-git),
#            url.ts    (Phase 3) GitHub URL validation/normalization — only
#                      https://github.com/<owner>/<repo> (+ .git / trailing slash /
#                      www.); everything else rejected for v1,
#                      clone.ts  (Phase 3) shallow clone (--depth 1 --single-branch) into
#                      .citycode-cache/clones/<owner>/<repo>; destination wiped
#                      first so re-imports get fresh HEAD; best-effort stale-clone
#                      sweep (>24h); all failures → one fixed readable error.
#                      Phase 6 additions: parseLsRemoteHead / resolveRemoteHead
#                      (one ls-remote round-trip for snapshot freshness) and
#                      readCloneHeadSha (intact-clone detection).
#   parser/  web-tree-sitter parsing → the shared graph model. Implemented:
#            sitter.ts     WASM init singleton; grammars load from each grammar
#                          package's OWN prebuild
#                          (node_modules/tree-sitter-{typescript,python}/
#                          tree-sitter-*.wasm) — NOT tree-sitter-wasms, whose
#                          2023-era builds fail to load in web-tree-sitter@0.27
#                          (Phase 0 Spike A finding). Languages: typescript,
#                          tsx, python.
#            extract.ts    file → functions + import statements (TS/TSX and —
#                          since the Python phase — also `import a.b` /
#                          `from a.b import x` / relative dots),
#            resolve.ts    TS: ./../ imports → intra-repo edges (bare/alias
#                          never edges). PY: absolute imports anchored at the
#                          repo root (dotted paths walked longest-prefix-first:
#                          a/b/c.py → a/b/c/__init__.py → a/b.py …), relative
#                          imports from the importer's package (one level per
#                          leading dot), unknown absolute modules → external
#                          (third-party), unknown relative → unresolved.
#            buildGraph.ts folder → CodeGraph (deterministic, byte-identical
#                          JSON). Phase 7: carries MAX_PARSE_FILES (1500) /
#                          MAX_TOTAL_LOC (400k) size cutoffs + BuildGraphOptions
#                          { skim?, maxParseFiles?, maxTotalLoc?, onProgress? }
#                          (the number overrides exist for tests only); above
#                          the cutoff without skim → SkimRequiredError, which
#                          the analyze route catches to auto-retry as a skim
#                          build. isSkimResult() detects the skim graph shape
#                          (files with no functions, zero edges). Skim = cheap
#                          fs reads only — per-file LOC, no tree-sitter parse,
#                          no functions, no edges; a "(repo)" warning explains
#                          the summarized city. Input-root fs errors map to
#                          fixed readable messages (ENOENT → "does not exist",
#                          EACCES/EPERM → "permission denied", ENAMETOOLONG →
#                          "path is too long", ENOTDIR → "not a folder"); a
#                          leading UTF-8 BOM is stripped before parse.
#   progress.ts (Phase 7, top-level lib/) — the NDJSON stream contract for
#            /api/analyze stage feedback: coarse progress lines
#            {"type":"progress","stage":…,"detail"?} (cloning/walking/parsing
#            "<N> files"/layout/saving/loading-snapshot), then
#            {"type":"result",…} or {"type":"error","error"} as the terminal
#            line (streamed runs keep HTTP 200). Streaming is negotiated per
#            request by the Accept header (NDJSON_ACCEPT =
#            application/x-ndjson); requests without it keep the original
#            single-JSON response byte-for-byte. Also exports the client-side
#            line reader/parser used by ImportForm.
#   city/    graph model → city layout. Implemented: layout.ts — CityLayout
#            types (Building/District/Road) + computeCityLayout(): deterministic
#            squarified treemap (Bruls et al. 2000), total-order sorted (area
#            desc, key asc), root rect 4:3 centered on origin, footprint
#            ∝ LOC with a √fnCount aspect nod clamped into the cell, height =
#            max(0.5, loc·heightPerLoc), roads = one per edge at building
#            centers. Consumed by components/city/ (R3F scene) via
#            /api/analyze; persisted by Phase 6 snapshots.
#   llm/     (Phase 3) Implemented: client.ts — one shared OpenAI SDK instance
#            against the standard OpenAI endpoint (OPENAI_API_KEY; model
#            gpt-6-luna @ reasoning_effort "medium", pinned in code); missing
#            key → LlmConfigError, which /api/explain maps to a readable 503
#            (city stays usable). prompts.ts — explain prompt builders + the
#            explainFile() chat call (lists capped, no raw file contents).
#            graphCache.ts — in-memory graph store (filled by /api/analyze,
#            keyed repoKey = source:repoPath via lib/repoKey.ts) + summary
#            cache keyed (repoKey, headSha, fileId) → one LLM call per file
#            ever. Phase 6 persists summaries into snapshots (and reads them
#            back before any LLM call), so reloads are LLM-free.
#   snapshot/ (Phase 6) The persistence layer — one JSON file per analyzed
#            repo state under .citycode-cache/snapshots/. schema.ts: the
#            versioned Snapshot shape (graph + layout + warnings + per-file
#            llmSummaries stamped with (size, mtimeMs) + compareSummaries
#            slots "prev:<sha>"/"workdir:<workdirHash>") + isSnapshot guard.
#            key.ts: filename = local/github-<sha256(repoKey|headSha)[:16]>;
#            mode is deliberately not a file-key component (compares reuse
#            the static snapshot's graph+layout and recompute only diffs).
#            fingerprint.ts: stat-walk state fingerprint for local repos
#            (same skip list/allowlist as the walker; no contents read) —
#            catches uncommitted edits that never move HEAD. save.ts:
#            atomic temp→rename writes, 7-day stale sweep (best-effort),
#            carryOverSummaries (untouched files keep explanations across
#            rebuilds). load.ts: fail-soft reads — missing/truncated/
#            wrong-version files are cache misses, never errors.
#
# types.ts holds the shared graph model (CodeGraph/FileNode/SymbolDef/
# ImportEdge) imported by every layer — static view and both compare modes
# render from the same shape. Languages: TypeScript/TSX + Python (the
# plan's "second language" stretch item, delivered early by user request —
# canvas-copilot being a Python repo was the trigger). Arrow-function consts,
# dynamic imports, and tsconfig aliases are not captured (TS scope); Python
# stray-package resolution is root-anchored only.
