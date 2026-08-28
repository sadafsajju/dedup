// Line diff for the merge review (FR-5.4: "a reviewable diff before anything
// is written").
//
// A merge rewrites whole files across the project, so the review is the only
// place the user can see what they are agreeing to. That makes the diff part
// of the safety model, not a presentational nicety: it must show every changed
// line, never elide one, and never claim a line is unchanged when it isn't.
//
// Myers' LCS over lines, with the common prefix/suffix stripped first — which
// is what makes it fast enough on the multi-hundred-line files a merge
// touches, since a rewrite usually changes a handful of lines in the middle.

export type DiffOp = "context" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old file (null for an added line). */
  before: number | null;
  /** 1-based line number in the new file (null for a removed line). */
  after: number | null;
}

export interface DiffHunk {
  beforeStart: number;
  afterStart: number;
  lines: DiffLine[];
}

/** Guard against pathological inputs — a generated file is not a review. */
const MAX_LINES = 6000;

/**
 * Split into displayable lines. A trailing newline is a terminator, not an
 * empty final line — keeping it would show a phantom blank addition on every
 * created file, and noise in a safety review is its own kind of defect. The
 * one thing this hides is a change that is *only* a trailing newline, which
 * the codemod cannot produce: it normalises every file it writes to end in
 * exactly one.
 */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = toLines(before);
  const b = toLines(after);

  // Common prefix / suffix: cheap, and it is most of a real file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) {
    out.push({ op: "context", text: a[i], before: i + 1, after: i + 1 });
  }

  const middle =
    midA.length * midB.length > MAX_LINES * MAX_LINES
      ? // Too big to align honestly — show it as a wholesale replacement
        // rather than spending minutes or, worse, guessing.
        [
          ...midA.map((text): [DiffOp, string] => ["remove", text]),
          ...midB.map((text): [DiffOp, string] => ["add", text]),
        ]
      : lcsDiff(midA, midB);

  let ai = head;
  let bi = head;
  for (const [op, text] of middle) {
    if (op === "context") {
      out.push({ op, text, before: ++ai, after: ++bi });
    } else if (op === "remove") {
      out.push({ op, text, before: ++ai, after: null });
    } else {
      out.push({ op, text, before: null, after: ++bi });
    }
  }
  for (let i = 0; i < tail; i++) {
    out.push({
      op: "context",
      text: a[a.length - tail + i],
      before: a.length - tail + i + 1,
      after: b.length - tail + i + 1,
    });
  }
  return out;
}

/** Classic LCS table walk. Only ever runs on the differing middle. */
function lcsDiff(a: string[], b: string[]): [DiffOp, string][] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: [DiffOp, string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(["context", a[i]]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(["remove", a[i++]]);
    } else {
      out.push(["add", b[j++]]);
    }
  }
  while (i < n) out.push(["remove", a[i++]]);
  while (j < m) out.push(["add", b[j++]]);
  return out;
}

/**
 * Group into hunks with `context` lines of surrounding context, the way a
 * patch reads. Unchanged stretches longer than 2×context collapse — but
 * nothing that changed is ever outside a hunk.
 */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines
    .map((l, i) => (l.op === "context" ? -1 : i))
    .filter((i) => i >= 0);
  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(lines.length - 1, changed[0] + context);
  for (const i of changed.slice(1)) {
    if (i - context <= end + 1) {
      end = Math.min(lines.length - 1, i + context);
    } else {
      hunks.push(sliceHunk(lines, start, end));
      start = Math.max(0, i - context);
      end = Math.min(lines.length - 1, i + context);
    }
  }
  hunks.push(sliceHunk(lines, start, end));
  return hunks;
}

function sliceHunk(lines: DiffLine[], start: number, end: number): DiffHunk {
  const slice = lines.slice(start, end + 1);
  return {
    beforeStart: slice.find((l) => l.before !== null)?.before ?? 0,
    afterStart: slice.find((l) => l.after !== null)?.after ?? 0,
    lines: slice,
  };
}

/** How many lines the change actually touches — the review's headline number. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "remove") removed++;
  }
  return { added, removed };
}
