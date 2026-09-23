import path from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { FileLanguage } from "../types";

/**
 * web-tree-sitter WASM initialization — the single place in the codebase that
 * knows where WASM files live.
 *
 * Two hard-won facts from the Phase 0 spike drive this module:
 *
 * 1. The core runtime WASM is `web-tree-sitter.wasm` (NOT `tree-sitter.wasm`)
 *    and is loaded via `Parser.init({ locateFile })` with an ABSOLUTE path —
 *    robust in Node under both vitest and a production Turbopack build, where
 *    `__dirname`/`import.meta.url` point somewhere useless.
 * 2. Grammar WASMs come from each grammar package's OWN prebuild (per the
 *    Spike A finding). The `tree-sitter-wasms` package is built with 2023-era
 *    tooling and fails to load in web-tree-sitter@0.27 (`getDylinkMetadata`
 *    error) — using it is forbidden.
 *
 * `process.cwd()` is the project root under both vitest and `next start`, so
 * all WASM paths are resolved from it. Paths with spaces (this project lives
 * in "E:/Personal Projects/...") are safe: every consumer uses fs APIs, never
 * a shell.
 */

/** Where each grammar's prebuilt WASM lives inside node_modules. */
const GRAMMAR_WASMS: Readonly<Record<FileLanguage, { readonly packageName: string; readonly filename: string }>> = {
  typescript: { packageName: "tree-sitter-typescript", filename: "tree-sitter-typescript.wasm" },
  tsx: { packageName: "tree-sitter-typescript", filename: "tree-sitter-tsx.wasm" },
  python: { packageName: "tree-sitter-python", filename: "tree-sitter-python.wasm" },
};

/** Core runtime WASM — ships inside the web-tree-sitter package itself. */
const CORE_PACKAGE = "web-tree-sitter";

/**
 * Absolute path of a WASM asset shipped inside node_modules.
 * The ONE function that computes WASM paths — nothing else may guess them.
 */
export function resolveWasmPath(packageName: string, filename: string): string {
  return path.join(process.cwd(), "node_modules", packageName, filename);
}

/** Parser.init promise — `Parser.init` must run once per process. */
let initPromise: Promise<void> | undefined;

/**
 * Initialize the web-tree-sitter runtime (idempotent, process-wide).
 * Safe to call from any module before touching Parser/Language.
 */
export function initSitter(): Promise<void> {
  initPromise ??= Parser.init({
    locateFile: (scriptName: string) => resolveWasmPath(CORE_PACKAGE, scriptName),
  });
  return initPromise;
}

const languagePromises = new Map<FileLanguage, Promise<Language>>();

/**
 * Load (and cache) a grammar language. A failed load is evicted from the
 * cache so a transient failure can't poison the process forever.
 */
export function getLanguage(language: FileLanguage): Promise<Language> {
  const cached = languagePromises.get(language);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    await initSitter();
    const grammar = GRAMMAR_WASMS[language];
    return Language.load(resolveWasmPath(grammar.packageName, grammar.filename));
  })();
  languagePromises.set(language, promise);
  // Evict on failure (the derived promise here is handled; the caller still
  // sees the original rejection).
  promise.catch(() => languagePromises.delete(language));
  return promise;
}

const parserPromises = new Map<FileLanguage, Promise<Parser>>();

/**
 * A ready-to-use Parser for a language (cached — Parser allocation lives in
 * the WASM heap, so per-file instantiation would leak).
 *
 * Parsers are NOT safe for concurrent use; the ingestion pipeline is strictly
 * sequential, which is the only supported usage.
 */
export function getParser(language: FileLanguage): Promise<Parser> {
  const cached = parserPromises.get(language);
  if (cached) {
    return cached;
  }
  const promise = getLanguage(language).then((loaded) => {
    const parser = new Parser();
    parser.setLanguage(loaded);
    return parser;
  });
  parserPromises.set(language, promise);
  promise.catch(() => parserPromises.delete(language));
  return promise;
}
