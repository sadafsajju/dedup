// Minimal TS/JSX syntax colouring for the code panel.
//
// Deliberately a lexer, not a parser, and deliberately not a dependency. The
// panel shows one file so the user can read and fix the thing dedup refused to
// edit — that needs strings, comments, keywords and tag names to separate at a
// glance, and nothing more. A real editor (Monaco, CodeMirror) is megabytes and
// a whole embedding story for a panel that exists to show ~40 lines.
//
// The one rule it must never break: `tokenize(src).map(t => t.text).join("") === src`.
// The panel paints these tokens *behind* a transparent textarea, so if the
// rendered text ever differed from the real text by a single character, the
// caret would sit in the wrong place. A test pins that.

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "tag";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "import", "export", "from", "default", "const", "let", "var", "function",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "new", "class", "extends", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "in", "of", "delete", "void",
  "yield", "this", "super", "null", "undefined", "true", "false",
  // TS
  "interface", "type", "enum", "implements", "as", "satisfies", "readonly",
  "public", "private", "protected", "static", "abstract", "declare", "namespace",
  "keyof", "infer", "is", "asserts",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

/**
 * Scan `source` into coloured runs. Single pass, no backtracking, and every
 * character is emitted exactly once — including the ones it does not colour.
 */
export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  const push = (kind: TokenKind, text: string) => {
    flush();
    out.push({ kind, text });
  };

  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Comments.
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      push("comment", source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      push("comment", source.slice(i, stop));
      i = stop;
      continue;
    }

    // Strings and templates. Escapes are honoured so a `\"` doesn't end one;
    // a run that never closes stops at the end of the file rather than eating
    // the rest of it as one token from some earlier line.
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          j++;
          break;
        }
        // A quoted string never spans lines; a template may.
        if (c !== "`" && source[j] === "\n") break;
        j++;
      }
      push("string", source.slice(i, j));
      i = j;
      continue;
    }

    // JSX tag name: the `<` or `</` plus the element name that follows it.
    // Purely lexical, so a less-than in an expression can look like a tag —
    // it needs an identifier immediately after to qualify, which `a < b`
    // (space) and `i<n` (lowercase is still a valid tag, but harmless to
    // colour) mostly settle in practice.
    if (c === "<" && (next === "/" || (next && IDENT_START.test(next)))) {
      let j = next === "/" ? i + 2 : i + 1;
      const start = j;
      while (j < n && (IDENT_PART.test(source[j]) || source[j] === ".")) j++;
      if (j > start) {
        push("tag", source.slice(i, j));
        i = j;
        continue;
      }
    }

    // Numbers.
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObBeE._]/.test(source[j])) j++;
      push("number", source.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < n && IDENT_PART.test(source[j])) j++;
      const word = source.slice(i, j);
      if (KEYWORDS.has(word)) push("keyword", word);
      else plain += word;
      i = j;
      continue;
    }

    plain += c;
    i++;
  }
  flush();
  return out;
}

/** Tailwind classes per token kind — one place, so the panel and any future
 * consumer colour identically. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "text-ink",
  comment: "text-ink-faint italic",
  string: "text-positive",
  keyword: "text-accent",
  number: "text-warn",
  tag: "text-danger",
};
