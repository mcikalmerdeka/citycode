/**
 * Tiny line-based syntax tokenizer for the demo's code viewer. Deliberately
 * not a parser: it colors comments, strings, numbers and keywords on one
 * line at a time, which is all a few highlighted lines need — no dependency,
 * no multi-line state (an excerpt may start mid-comment, and that is fine).
 */

export type TokenKind = "plain" | "comment" | "string" | "keyword" | "number";

export interface Token {
  text: string;
  kind: TokenKind;
}

export type CodeLanguage = "ts" | "py";

const TS_KEYWORDS = new Set([
  "import", "from", "export", "default", "const", "let", "var", "function", "return", "if", "else", "for",
  "while", "switch", "case", "break", "continue", "new", "class", "extends", "implements", "interface",
  "type", "enum", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of",
  "as", "null", "undefined", "true", "false", "this", "void", "public", "private", "protected", "readonly",
  "static", "yield",
]);

const PY_KEYWORDS = new Set([
  "import", "from", "as", "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and",
  "or", "is", "None", "True", "False", "try", "except", "finally", "raise", "with", "lambda", "yield", "async",
  "await", "pass", "break", "continue", "global", "nonlocal", "self",
]);

/** Language of a file id by extension (Python, else the TS family). */
export function languageOf(fileId: string): CodeLanguage {
  return fileId.toLowerCase().endsWith(".py") ? "py" : "ts";
}

function push(tokens: Token[], text: string, kind: TokenKind): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

export function tokenizeLine(line: string, language: CodeLanguage): Token[] {
  const tokens: Token[] = [];
  const keywords = language === "py" ? PY_KEYWORDS : TS_KEYWORDS;

  // Block-comment bodies (` * text`, `/* … */`) read as comments on their own line.
  if (language === "ts" && /^\s*(\/\*|\*)/.test(line)) return [{ text: line, kind: "comment" }];

  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if ((language === "ts" && ch === "/" && line[i + 1] === "/") || (language === "py" && ch === "#")) {
      push(tokens, line.slice(i), "comment");
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      push(tokens, line.slice(i, Math.min(line.length, j + 1)), "string");
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[0-9._]/.test(line[j]!)) j++;
      push(tokens, line.slice(i, j), "number");
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      push(tokens, word, keywords.has(word) ? "keyword" : "plain");
      i = j;
      continue;
    }
    push(tokens, ch, "plain");
    i += 1;
  }
  return tokens;
}
