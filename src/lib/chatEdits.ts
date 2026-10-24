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
//      file, plus whole CREATE files, ASSET imports and IMAGE requests (an
//      image the model asks another agent to generate). Output tokens scale
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

/**
 * An image the model wants but cannot make, asked of an agent that can.
 *
 * Where an ASSET block says "I generated this file, import it", an IMAGE block
 * says "have one generated". It names no source path at all — the model only
 * describes the picture — so the request adds nothing to what can reach the
 * project: dedup asks the generating agent, and *that* agent's answer is an
 * ordinary ASSET import through the same gates as if it had been asked
 * directly (`pickGeneratedImage`, then `asset.rs`).
 */
export interface ImageRequest {
  /** Project-relative destination. */
  file: string;
  /** What the image should show, in the requesting model's words. */
  prompt: string;
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
      images: ImageRequest[];
      summary: string;
    }
  | { kind: "file"; content: string; summary: string }
  | { kind: "answer"; text: string };

const SEARCH_MARK = "<<<<<<< SEARCH";
const DIVIDE_MARK = "=======";
const REPLACE_MARK = ">>>>>>> REPLACE";
const CREATE_MARK = "<<<<<<< CREATE";
const ASSET_MARK = "<<<<<<< ASSET";
const IMAGE_MARK = "<<<<<<< IMAGE";
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
  images: ImageRequest[];
} {
  const blocks: EditBlock[] = [];
  const creates: NewFile[] = [];
  const assets: AssetImport[] = [];
  const images: ImageRequest[] = [];
  let state: "outside" | "search" | "replace" | "create" | "asset" | "image" =
    "outside";
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
    } else if (trimmed.startsWith(IMAGE_MARK)) {
      if (state !== "outside") throw new Error("nested IMAGE marker");
      const named = fileOfMarker(trimmed, IMAGE_MARK);
      if (!named) throw new Error("IMAGE marker without a destination path");
      state = "image";
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
      } else if (state === "image") {
        // The description is prose and kept as written; only an empty one is
        // refused, because "generate something" is not a request the other
        // agent can answer and its failure would be blamed on the wrong one.
        const prompt = body.join("\n").trim();
        if (prompt === "") throw new Error("an IMAGE block must describe the image");
        images.push({ file: file as string, prompt });
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
    } else if (state === "create" || state === "asset" || state === "image") {
      body.push(line);
    }
  }
  if (state !== "outside") throw new Error("unterminated edit block");
  return { blocks, creates, assets, images };
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
    text.includes(ASSET_MARK) ||
    text.includes(IMAGE_MARK)
  ) {
    const { blocks, creates, assets, images } = parseEdits(text);
    return {
      kind: "blocks",
      blocks,
      creates,
      assets,
      images,
      summary: parseSummary(text),
    };
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

/**
 * The generated file in the answer to an IMAGE request — the one thing dedup
 * takes from that reply.
 *
 * The generating agent was asked for an image and nothing else, so anything
 * else in its answer is refused rather than salvaged: an edit or a created
 * file would be a second agent writing source the user asked a *different*
 * agent about, which nobody reviewed the request for. Exactly one ASSET block;
 * its destination is ignored in favour of the one the requester chose, because
 * that is the path the requester's markup already points at.
 */
export function pickGeneratedImage(raw: string): string {
  let reply: ChatReply;
  try {
    reply = parseChatReply(raw);
  } catch (e) {
    throw new Error(
      `its answer was malformed (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (reply.kind !== "blocks") {
    const said = reply.kind === "answer" ? reply.text : "";
    throw new Error(
      said
        ? `it didn't produce an image: ${said.slice(0, 200)}`
        : "it didn't produce an image",
    );
  }
  if (reply.blocks.length || reply.creates.length || reply.images.length) {
    throw new Error("it answered with code changes instead of only an image");
  }
  if (reply.assets.length !== 1) {
    throw new Error(
      `it returned ${reply.assets.length} images where one was asked for`,
    );
  }
  return reply.assets[0].source;
}

/**
 * Point a proposal's references at the name an image actually landed under.
 *
 * An IMAGE request names its destination before the image exists, and the
 * generating agent decides the format — so `hero.jpg` can come back as a PNG,
 * and the import names it `hero.png` (the name must agree with the bytes).
 * The requester's markup still says `hero.jpg`; this renames those references.
 *
 * Only references **this edit introduced**. The file did not exist until now,
 * so a reference to it in a file's *before* contents is something the user
 * wrote, about something else, and is refused rather than renamed. Matched on
 * the file name with path-character boundaries on both sides, so
 * `big-hero.jpg` is not a reference to `hero.jpg`.
 */
export function retargetReferences<
  F extends { file: string; before: string | null; after: string },
>(files: F[], from: string, to: string): F[] {
  const fromName = from.split("/").pop() ?? from;
  const toName = to.split("/").pop() ?? to;
  if (fromName === toName) return files;
  const ref = new RegExp(
    `(?<![\\w.-])${fromName.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w.-])`,
    "g",
  );
  return files.map((f) => {
    ref.lastIndex = 0;
    if (!ref.test(f.after)) return f;
    ref.lastIndex = 0;
    if (f.before !== null && ref.test(f.before)) {
      throw new Error(
        `${f.file} already mentioned ${fromName} before this edit, so dedup can't tell which references to rename to ${toName}`,
      );
    }
    ref.lastIndex = 0;
    return { ...f, after: f.after.replace(ref, toName) };
  });
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
