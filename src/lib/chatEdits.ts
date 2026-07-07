// Parsing + applying the chat model's reply. Pure string work, no deps —
// tested standalone (pnpm test:chat).
//
// The model replies with targeted SEARCH/REPLACE blocks (not the whole file):
// output tokens scale with the size of the *change*, which is what makes chat
// edits land in seconds instead of minutes. A full-file fenced reply is still
// accepted as a fallback; anything else is treated as a prose answer.

export interface EditBlock {
  search: string;
  replace: string;
}

/** What the model said: targeted blocks, a whole file, or a prose answer. */
export type ChatReply =
  | { kind: "blocks"; blocks: EditBlock[]; summary: string }
  | { kind: "file"; content: string; summary: string }
  | { kind: "answer"; text: string };

const SEARCH_MARK = "<<<<<<< SEARCH";
const DIVIDE_MARK = "=======";
const REPLACE_MARK = ">>>>>>> REPLACE";

function parseSummary(text: string): string {
  return /^SUMMARY:\s*(.+)$/m.exec(text)?.[1].trim() ?? "apply chat edit";
}

/** Strict line-based parse of SEARCH/REPLACE blocks. Throws on malformed
 * markers — a garbled edit must fail loudly, never half-apply. */
function parseBlocks(text: string): EditBlock[] {
  const lines = text.split("\n");
  const blocks: EditBlock[] = [];
  let state: "outside" | "search" | "replace" = "outside";
  let search: string[] = [];
  let replace: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === SEARCH_MARK) {
      if (state !== "outside") throw new Error("nested SEARCH marker");
      state = "search";
      search = [];
      replace = [];
    } else if (line.trim() === DIVIDE_MARK && state === "search") {
      state = "replace";
    } else if (line.trim() === REPLACE_MARK) {
      if (state !== "replace") throw new Error("REPLACE marker without a ======= divider");
      if (search.length === 0) throw new Error("empty SEARCH section");
      blocks.push({ search: search.join("\n"), replace: replace.join("\n") });
      state = "outside";
    } else if (state === "search") {
      search.push(line);
    } else if (state === "replace") {
      replace.push(line);
    }
  }
  if (state !== "outside") throw new Error("unterminated edit block");
  return blocks;
}

export function parseChatReply(raw: string): ChatReply {
  const text = raw.trim();

  if (text.includes(SEARCH_MARK)) {
    return {
      kind: "blocks",
      blocks: parseBlocks(text),
      summary: parseSummary(text),
    };
  }

  // Fallback: a full file in one fence (models sometimes do this anyway).
  const open = text.indexOf("```");
  if (open !== -1) {
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
 * else throws with a reason the chat can show. */
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
