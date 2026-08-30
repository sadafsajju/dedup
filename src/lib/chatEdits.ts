// Parsing + applying the chat agent's reply. Pure string work, no deps —
// tested standalone (pnpm test:chat).
//
// The model has three things it can say, and the parse is what tells them
// apart:
//
//   1. "show me more" — TOOL lines. dedup runs them (read/grep/list, all
//      read-only) and hands the results back as another turn. This is how a
//      chat with nothing selected finds its way around the project: the model
//      never touches the filesystem, it asks and dedup answers.
//   2. "here is the edit" — SEARCH/REPLACE blocks, optionally addressed to a
//      file, plus whole CREATE files and ASSET imports. Output tokens scale
//      with the size of the *change*, which is what makes chat edits land in
//      seconds.
//   3. "here is my answer" — prose, no code written.
//
// Nothing here writes anything. A parsed edit is a *proposal*: the store
// turns it into a diff the user accepts or rejects, and only then does the
// parse-gated sidecar write it.

/** One targeted replacement. `file` is null when the model didn't address the
 *  block — in a single-file conversation that means "the file we're editing". */
export interface EditBlock {
  file: string | null;
  search: string;
  replace: string;
}

/** A file the model wants to create (extracting a component, mostly). */
export interface NewFile {
  file: string;
  content: string;
}

/**
 * A binary the agent produced and wants placed in the project — an image it
 * generated, which is the only kind of file it can make that cannot be typed
 * out as text.
 *
 * `source` is an absolute path on this machine, and that is exactly why it is
 * a *request* rather than an instruction: it is the one thing the model can
 * say that names a file outside the project, so dedup answers it under gates
 * of its own (`asset.rs`) instead of copying what it was told to.
 */
export interface AssetImport {
  /** Project-relative destination. */
  file: string;
  /** Absolute path the agent wrote its output to. */
  source: string;
}

/** Read-only context requests. `arg` is a path for read, a pattern for grep,
 *  and ignored for list. */
export interface ToolCall {
  tool: "read" | "grep" | "list";
  arg: string;
}

/** What the model said. */
export type ChatReply =
  | { kind: "tools"; calls: ToolCall[]; note: string }
  | {
      kind: "blocks";
      blocks: EditBlock[];
      creates: NewFile[];
      assets: AssetImport[];
      summary: string;
    }
  | { kind: "file"; content: string; summary: string }
  | { kind: "answer"; text: string };

const SEARCH_MARK = "<<<<<<< SEARCH";
const DIVIDE_MARK = "=======";
const REPLACE_MARK = ">>>>>>> REPLACE";
const CREATE_MARK = "<<<<<<< CREATE";
const ASSET_MARK = "<<<<<<< ASSET";
const END_MARK = ">>>>>>> END";
const TOOL_RE = /^TOOL:\s*(read|grep|list)\b\s*(.*)$/i;

/** How many context round-trips one instruction may take before dedup stops
 *  and says so. High enough for "find the component, read it, read its
 *  parent"; low enough that a confused model can't spin. */
export const MAX_TOOL_ROUNDS = 6;

function parseSummary(text: string): string {
  return /^SUMMARY:\s*(.+)$/m.exec(text)?.[1].trim() ?? "apply chat edit";
}

/**
 * Strip decoration a model wraps a path in.
 *
 * The prompt writes its placeholders as `<project-relative path>`, and models
 * copy that convention literally often enough to matter — `<<<<<<< ASSET
 * <public/hero.png>` arrived at the import gate as a file whose extension was
 * `png>`, which is a confusing way to be told the model made a typo. Quotes
 * and backticks are the same reflex. A real path wears none of them, so taking
 * them off is unambiguous rather than a guess (`parseTools` has always done
 * this for TOOL arguments; markers had not).
 *
 * Looped because a path can wear two layers, as `"<a.png>"`.
 */
export function undecoratePath(path: string): string {
  let out = path.trim();
  for (;;) {
    const next = out
      // Angle brackets, even unpaired. A model that opens one does not
      // reliably close it, and `public/hero.png>` produced exactly the same
      // unreadable complaint as `<public/hero.png>` did. Unconditional is
      // safe here in a way it would not be for quotes: `<` and `>` are
      // illegal in a Windows path and essentially never seen in a real one
      // anywhere else, so finding one at either end means decoration.
      .replace(/^<+/, "")
      .replace(/>+$/, "")
      // Quotes only in balanced pairs — a filename may legitimately contain
      // an apostrophe, and `it's.png` must survive.
      .replace(/^"([^"]*)"$/, "$1")
      .replace(/^'([^']*)'$/, "$1")
      .replace(/^`([^`]*)`$/, "$1")
      .trim();
    if (next === out) return out;
    out = next;
  }
}

/** The file a marker line is addressed to: `<<<<<<< SEARCH src/App.tsx`.
 *  Bare markers keep the old meaning and return null. */
function fileOfMarker(line: string, mark: string): string | null {
  const rest = undecoratePath(line.trim().slice(mark.length));
  return rest === "" ? null : rest;
}

/**
 * Strict line-based parse of the edit markers. Throws on anything malformed —
 * a garbled edit must fail loudly, never half-apply.
 */
function parseEdits(text: string): {
  blocks: EditBlock[];
  creates: NewFile[];
  assets: AssetImport[];
} {
  const blocks: EditBlock[] = [];
  const creates: NewFile[] = [];
  const assets: AssetImport[] = [];
  let state: "outside" | "search" | "replace" | "create" | "asset" = "outside";
  let file: string | null = null;
  let search: string[] = [];
  let replace: string[] = [];
  let body: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();

    if (trimmed.startsWith(SEARCH_MARK)) {
      if (state !== "outside") throw new Error("nested SEARCH marker");
      state = "search";
      file = fileOfMarker(trimmed, SEARCH_MARK);
      search = [];
      replace = [];
    } else if (trimmed.startsWith(CREATE_MARK)) {
      if (state !== "outside") throw new Error("nested CREATE marker");
      const named = fileOfMarker(trimmed, CREATE_MARK);
      if (!named) throw new Error("CREATE marker without a file path");
      state = "create";
      file = named;
      body = [];
    } else if (trimmed.startsWith(ASSET_MARK)) {
      if (state !== "outside") throw new Error("nested ASSET marker");
      const named = fileOfMarker(trimmed, ASSET_MARK);
      if (!named) throw new Error("ASSET marker without a destination path");
      state = "asset";
      file = named;
      body = [];
    } else if (trimmed === DIVIDE_MARK && state === "search") {
      state = "replace";
    } else if (trimmed === REPLACE_MARK) {
      if (state !== "replace") {
        throw new Error("REPLACE marker without a ======= divider");
      }
      if (search.length === 0) throw new Error("empty SEARCH section");
      blocks.push({ file, search: search.join("\n"), replace: replace.join("\n") });
      state = "outside";
    } else if (trimmed === END_MARK) {
      if (state === "asset") {
        // Exactly one path, and nothing else. An ASSET block is not content —
        // it is a reference to a file dedup will go and look at — so a body
        // that isn't a single path is a misunderstanding, not a value to
        // salvage.
        const lines = body
          .map((l) => undecoratePath(l))
          .filter((l) => l !== "");
        if (lines.length !== 1) {
          throw new Error("an ASSET block must hold exactly one file path");
        }
        assets.push({ file: file as string, source: lines[0] });
        state = "outside";
      } else {
        if (state !== "create") throw new Error("END marker outside a CREATE block");
        if (body.join("\n").trim() === "") throw new Error("empty CREATE block");
        creates.push({ file: file as string, content: `${body.join("\n")}\n` });
        state = "outside";
      }
    } else if (state === "search") {
      search.push(line);
    } else if (state === "replace") {
      replace.push(line);
    } else if (state === "create" || state === "asset") {
      body.push(line);
    }
  }
  if (state !== "outside") throw new Error("unterminated edit block");
  return { blocks, creates, assets };
}

function parseTools(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const raw of text.split("\n")) {
    const m = TOOL_RE.exec(raw.trim());
    if (!m) continue;
    const tool = m[1].toLowerCase() as ToolCall["tool"];
    const arg = m[2].trim().replace(/^["'`]|["'`]$/g, "");
    if (tool !== "list" && arg === "") continue; // a request for nothing
    calls.push({ tool, arg });
  }
  return calls;
}

export function parseChatReply(raw: string): ChatReply {
  const text = raw.trim();

  // Edits win over tool lines: a reply that contains both has decided.
  if (
    text.includes(SEARCH_MARK) ||
    text.includes(CREATE_MARK) ||
    text.includes(ASSET_MARK)
  ) {
    const { blocks, creates, assets } = parseEdits(text);
    return { kind: "blocks", blocks, creates, assets, summary: parseSummary(text) };
  }

  const calls = parseTools(text);
  if (calls.length > 0) {
    return {
      kind: "tools",
      calls,
      note: text.replace(/^TOOL:.*$/gim, "").trim(),
    };
  }

  // Fallback: a whole file in one fence (models sometimes do this anyway).
  // It needs a SUMMARY line to count — without one, a fenced snippet inside a
  // prose answer is just an illustration, and treating it as a file rewrite
  // would blank the rest of the module.
  const open = text.indexOf("```");
  if (open !== -1 && /^SUMMARY:\s*.+$/m.test(text)) {
    const close = text.lastIndexOf("```");
    const afterOpen = text.indexOf("\n", open);
    if (close > open && afterOpen !== -1 && afterOpen < close) {
      let content = text.slice(afterOpen + 1, close);
      if (!content.endsWith("\n")) content += "\n";
      return { kind: "file", content, summary: parseSummary(text.slice(close)) };
    }
  }

  return { kind: "answer", text };
}

/** Apply blocks to `source`. Each SEARCH must match exactly once — anything
 *  else throws with a reason the chat can show. */
export function applyEditBlocks(source: string, blocks: EditBlock[]): string {
  let out = source;
  for (const [i, b] of blocks.entries()) {
    const at = out.indexOf(b.search);
    if (at === -1) {
      throw new Error(
        `edit ${i + 1}/${blocks.length} didn't match the file — the AI misquoted the source. Try again.`,
      );
    }
    if (out.indexOf(b.search, at + b.search.length) !== -1) {
      throw new Error(
        `edit ${i + 1}/${blocks.length} matches more than one place — ambiguous, nothing was changed. Try again with a more specific instruction.`,
      );
    }
    out = out.slice(0, at) + b.replace + out.slice(at + b.search.length);
  }
  return out;
}

/**
 * Apply a multi-file program: group the blocks by the file they name, fold in
 * the created files, and return every file's new content.
 *
 * `sources` holds what dedup read; `fallback` is the file an unaddressed
 * block belongs to (the selection's file, or the only file in play). A block
 * naming a file dedup never read is refused rather than guessed at — the
 * model would be quoting from memory, and a SEARCH it invented is exactly the
 * thing the exact-match rule exists to catch.
 */
export function applyProgram(
  sources: Map<string, string>,
  blocks: EditBlock[],
  creates: NewFile[],
  fallback: string | null,
): Map<string, string> {
  const byFile = new Map<string, EditBlock[]>();
  for (const b of blocks) {
    const file = b.file ?? fallback;
    if (!file) {
      throw new Error(
        "the AI proposed an edit without saying which file it belongs to",
      );
    }
    if (!sources.has(file)) {
      throw new Error(
        `the AI edited ${file}, which it never read — nothing was changed. Ask again and it will read the file first.`,
      );
    }
    byFile.set(file, [...(byFile.get(file) ?? []), b]);
  }

  const out = new Map<string, string>();
  for (const [file, list] of byFile) {
    out.set(file, applyEditBlocks(sources.get(file) as string, list));
  }
  for (const c of creates) {
    if (out.has(c.file) || sources.has(c.file)) {
      throw new Error(
        `the AI tried to create ${c.file}, which already exists — nothing was changed.`,
      );
    }
    out.set(c.file, c.content);
  }
  return out;
}
