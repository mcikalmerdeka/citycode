import type { Node, Tree } from "web-tree-sitter";
import type { FileLanguage, SymbolDef } from "../types";
import { getParser } from "./sitter";

/**
 * One static import / re-export statement found in a file.
 * Dynamic `import()` and `require()` are out of scope (documented limitation).
 */
export interface ExtractedImport {
  /** Module specifier exactly as written, e.g. "./util", "react", "@/lib/x". */
  specifier: string;
  /**
   * Named specifiers (`import { a, b } from ...` / `export { a } from ...`).
   * Empty for default / namespace / side-effect / star statements.
   */
  symbols: string[];
}

/** Raw per-file extraction result, before import resolution. */
export interface ExtractionResult {
  /** Named function declarations + class methods, sorted by (startLine, name). */
  functions: SymbolDef[];
  /** Import and re-export statements in document order. */
  imports: ExtractedImport[];
}

/**
 * Parse one source file and extract functions + import statements.
 *
 * Extraction is written against the installed grammar's actual node shapes
 * (empirically dumped from the installed grammars during Phase 1):
 * * - `import_statement` always has a `source` field (a `string` wrapping a
 *   `string_fragment`); side-effect-only imports have no import clause.
 * - `export_statement` is a re-export ONLY when it has a `source` field —
 *   `export { a }` / `export const x` have none and are not imports.
 * - `export function` / `export default class` wrap their declaration inside
 *   an export_statement, so a full recursive walk finds them naturally.
 *
 * Throws when the file cannot be parsed — buildGraph catches and skips.
 */
export async function extractFromFile(
  language: FileLanguage,
  source: string
): Promise<ExtractionResult> {
  const parser = await getParser(language);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(source);
    if (tree === null) {
      throw new Error("parse returned no tree");
    }
    const functions: SymbolDef[] = [];
    const imports: ExtractedImport[] = [];
    walkNode(tree.rootNode, functions, imports);
    functions.sort((a, b) => (a.startLine !== b.startLine ? a.startLine - b.startLine : a.name < b.name ? -1 : 1));
    return { functions, imports };
  } finally {
    // Free the WASM-side tree; everything extracted is plain JS already.
    tree?.delete();
  }
}

/** Recursive walk over named children — imports anywhere in the tree count. */
function walkNode(node: Node, functions: SymbolDef[], imports: ExtractedImport[]): void {
  switch (node.type) {
    case "import_statement": {
      // Node shapes verified empirically against the installed grammars:
      // - TypeScript/JS: `import <clause> from "<src>"` / re-exports, keyed by
      //   the `source` field; side-effect imports have no clause.
      // - Python: `import a.b` / `import x as y` — module is the first
      //   `dotted_name` (plain or wrapped in `aliased_import`); bare edge,
      //   no named symbols.
      const moduleText = firstDottedNameText(node);
      if (moduleText !== undefined) {
        imports.push({ specifier: moduleText, symbols: [] });
        return;
      }
      const importPath = extractSourceString(node);
      if (importPath !== undefined) {
        const symbols: string[] = [];
        collectSpecifierNames(node, "import_specifier", symbols);
        imports.push({ specifier: importPath, symbols });
      }
      // Side-effect imports (no clause) still have nothing below them; but
      // plain imports could theoretically nest nothing either. No recursion.
      return;
    }
    case "import_from_statement": {
      // Python `from <module> import a, b` — module comes from the
      // `module_name` field ("mypkg.sub", ".", ".inner.mod"); the remaining
      // dotted_name/aliased_import children are the imported names.
      const moduleNode = node.childForFieldName("module_name");
      if (moduleNode !== null) {
        const symbolNodes: string[] = [];
        for (const child of node.namedChildren) {
          if (child.id === moduleNode.id) {
            continue;
          }
          const text = firstDottedNameText(child);
          if (text !== undefined) {
            symbolNodes.push(text);
          }
        }
        imports.push({ specifier: moduleNode.text, symbols: symbolNodes });
        return;
      }
      break;
    }
    case "export_statement": {
      // A re-export (`export ... from "./x"`) carries a source field; plain
      // exports don't and may WRAP a declaration (e.g. export function f()),
      // so they must fall through to recursion below.
      const exportPath = extractSourceString(node);
      if (exportPath !== undefined) {
        const symbols: string[] = [];
        collectSpecifierNames(node, "export_specifier", symbols);
        imports.push({ specifier: exportPath, symbols });
        return;
      }
      break;
    }
    case "function_declaration":
    case "generator_function_declaration":
    case "method_definition":
    case "function_definition": { // Python def / async def — same name-field shape
      const nameNode = node.childForFieldName("name");
      if (nameNode !== null && nameNode.text.length > 0) {
        functions.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
      return;
    }
    default:
      break;
  }
  for (const child of node.namedChildren) {
    walkNode(child, functions, imports);
  }
}

/** Module specifier of an import/export statement: the `source` field's string_fragment text. */
function extractSourceString(node: Node): string | undefined {
  const sourceNode = node.childForFieldName("source");
  if (sourceNode === null) {
    return undefined;
  }
  for (const child of sourceNode.namedChildren) {
    if (child.type === "string_fragment") {
      return child.text;
    }
  }
  // Malformed string literal (e.g. unterminated) — no usable specifier.
  return undefined;
}

/**
 * Text of the first `dotted_name` under `node`, unwrapping `aliased_import`.
 * For `import a.b` / `from a.b import x` this yields "a.b" without the "as"
 * alias. Returns undefined when no dotted_name exists (non-Python grammars,
 * malformed statements).
 */
function firstDottedNameText(node: Node): string | undefined {
  if (node.type === "dotted_name") {
    return node.text;
  }
  if (node.type === "aliased_import") {
    return firstDottedNameText(node.namedChildren[0]);
  }
  for (const child of node.namedChildren) {
    if (child.type === "dotted_name") {
      return child.text;
    }
    if (child.type === "aliased_import") {
      return firstDottedNameText(child);
    }
  }
  return undefined;
}

/** Collect the `name` of every specifier node of the given type under `node`. */
function collectSpecifierNames(node: Node, specifierType: string, out: string[]): void {
  if (node.type === specifierType) {
    const nameNode = node.childForFieldName("name");
    if (nameNode !== null && nameNode.text.length > 0) {
      out.push(nameNode.text);
    }
    return;
  }
  for (const child of node.namedChildren) {
    collectSpecifierNames(child, specifierType, out);
  }
}

