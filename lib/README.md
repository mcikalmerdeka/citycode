# lib/ — core application logic (see project-description/citycode-tech-stack-v2.md §9)
#
# Each subfolder maps to one layer of the pipeline:
#
#   git/     simple-git wrappers. Implemented: local.ts (deterministic .ts/.tsx
#            folder walk skipping node_modules/.git/.next/dist/build/
#            .citycode-cache; git repo detection + HEAD sha via simple-git).
#            Clone/diff wrappers arrive in Phase 3/4/5.
#   parser/  web-tree-sitter parsing → the shared graph model. Implemented:
#            sitter.ts     WASM init singleton; grammars load from each grammar
#                          package's OWN prebuild
#                          (node_modules/tree-sitter-typescript/tree-sitter-{typescript,tsx}.wasm) —
#                          NOT tree-sitter-wasms, whose 2023-era builds fail to
#                          load in web-tree-sitter@0.27 (Phase 0 Spike A finding).
#            extract.ts    file → functions + import statements
#            resolve.ts    ./../ imports → intra-repo edges (bare/alias never edges)
#            buildGraph.ts folder → CodeGraph (deterministic, byte-identical JSON)
#   city/    (Phase 2) graph model → city layout (buildings, districts, roads)
#   llm/     (Phase 3) OpenCode GLM client (openai SDK, baseURL from env) + summary prompts
#
# types.ts holds the shared graph model (CodeGraph/FileNode/SymbolDef/
# ImportEdge) imported by every layer — static view and both compare modes
# render from the same shape. Phase 1 limitation: TypeScript/TSX only; arrow-
# function consts, dynamic imports, and tsconfig aliases are not captured.
