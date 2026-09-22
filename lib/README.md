# lib/ — core application logic (see project-description/citycode-tech-stack-v2.md §9)
#
# Each subfolder maps to one layer of the pipeline:
#
#   git/     simple-git wrappers: shallow clone (HEAD only), diff HEAD~1,
#            diff working directory (git status --porcelain)
#   parser/  web-tree-sitter parsing -> file/function/import graph model
#            (WASM grammars from tree-sitter-wasms/out/*.wasm)
#   city/    graph model -> city layout (buildings, districts, roads)
#   llm/     OpenCode GLM client (openai SDK, baseURL from env) + summary prompts
#
# These are placeholders so the layout is committed; replace this file as
# each module gets implemented. Types for the shared graph model should live
# here and be imported by every layer, since static view and both compare
# modes render from the same shape.
