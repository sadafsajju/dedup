// Source-text helpers shared by every write-back path (JSX and HTML).
//
// These are the parts of an edit that have nothing to do with the language
// being edited: where a line starts, what a block's indentation is, and how a
// captured block is re-indented for a new home. The JSX write-back grew them
// first; the HTML one needs exactly the same behaviour, and two copies of
// "take the whole line when the element owns it" would drift the first time
// one of them was tuned.

/** Indentation of the line `pos` sits on. */
export function indentAt(code, pos) {
  const lineStart = code.lastIndexOf("\n", pos - 1) + 1;
  const m = code.slice(lineStart, pos).match(/^[ \t]*/);
  return m ? m[0] : "";
}

/** Start of the line `pos` sits on (so removals take the whole line). */
export function lineStartOf(code, pos) {
  return code.lastIndexOf("\n", pos - 1) + 1;
}

/** End of the line `pos` sits on, including its newline. */
export function lineEndOf(code, pos) {
  const nl = code.indexOf("\n", pos);
  return nl === -1 ? code.length : nl + 1;
}

/**
 * Re-indent a captured block for its new home: strip the block's own base
 * indentation from every line after the first, then apply the target's.
 * Moved markup that lands a level deeper reads as if it were typed there.
 */
export function reindent(text, fromIndent, toIndent) {
  if (fromIndent === toIndent) return text;
  return text
    .split("\n")
    .map((line, i) => {
      if (i === 0) return line;
      const stripped = line.startsWith(fromIndent) ? line.slice(fromIndent.length) : line;
      return stripped.trim() === "" ? stripped : toIndent + stripped;
    })
    .join("\n");
}

/** True when nothing but whitespace precedes `start` on its line. */
export function ownsLine(code, start) {
  return code.slice(lineStartOf(code, start), start).trim() === "";
}

/**
 * The range to delete for an element spanning [start, end): just the element
 * when it shares its line with other content, the whole line (or lines) when
 * it owns them, so a removal never leaves a blank behind.
 */
export function removalRange(code, start, end) {
  if (!ownsLine(code, start)) return { start, end };
  const after = code.slice(end, lineEndOf(code, end));
  if (after.trim() !== "") return { start, end };
  return { start: lineStartOf(code, start), end: lineEndOf(code, end) };
}
