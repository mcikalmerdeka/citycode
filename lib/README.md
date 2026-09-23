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
#            clone.ts  (Phase 3) shallow clone (--depth 1 --single-branch) into
#                      .citycode-cache/clones/<owner>/<repo>; destination wiped
#                      first so re-imports get fresh HEAD; best-effort stale-clone
#                      sweep (>24h); all failures → one fixed readable error.
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
#            buildGraph.ts folder → CodeGraph (deterministic, byte-identical JSON)
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
#            ever. Phase 6 persists summaries into snapshots.
#
# types.ts holds the shared graph model (CodeGraph/FileNode/SymbolDef/
# ImportEdge) imported by every layer — static view and both compare modes
# render from the same shape. Languages: TypeScript/TSX + Python (the
# plan's "second language" stretch item, delivered early by user request —
# canvas-copilot being a Python repo was the trigger). Arrow-function consts,
# dynamic imports, and tsconfig aliases are not captured (TS scope); Python
# stray-package resolution is root-anchored only.
