// Inspector chat (AI edits): the user selects an element on the canvas and
// types an instruction; the model receives the whole source file with the
// selection marked and must return the complete updated file. The reply is
// never trusted — the sidecar re-parses it before any write (PRD safety
// model), and every applied edit is its own commit on the session branch.
//
// Unlike categorization, this explicitly sends the selected file's source to
// the chosen AI backend — the chat UI says so (honesty over magic).

import Anthropic from "@anthropic-ai/sdk";
import type { AiBackend } from "./categorize";
import type { SelectedElement } from "./types";

const SYSTEM_PROMPT = `You are an expert React + Tailwind engineer working inside "dedup", a visual code editor. The user has selected one JSX element in a source file and typed an instruction. Apply the instruction to the file.

Rules:
- Keep the change minimal and scoped to the instruction; preserve imports, formatting, comments, and unrelated code exactly as they are.
- Stay within this one file: no new files, no renames, no new dependencies.
- Tailwind for styling; match the file's existing conventions.

Reply format (strict):
- If you changed the code: output one edit block per change, in exactly this form:
<<<<<<< SEARCH
lines copied character-for-character from the current file
=======
the replacement lines
>>>>>>> REPLACE
- SEARCH must quote the file verbatim (indentation and spacing included) and must be unique in the file — include a neighboring line or two when needed for uniqueness. Keep blocks small: only the lines that change plus what uniqueness requires.
- After the last block, end with a single line "SUMMARY: <imperative one-liner of what changed>".
- If the instruction cannot be done safely within this file, or it is a question needing no code change: reply in plain prose with NO edit blocks.`;

export interface ChatEditTarget {
  file: string;
  /** Live line of the element's opening tag, from the write-back's inspect
   * (0 when unknown — the prompt just omits the line hint then). */
  line: number;
}

export function buildEditPrompt(
  target: ChatEditTarget,
  selected: SelectedElement,
  source: string,
  instruction: string,
): string {
  const name = selected.component
    ? `<${selected.tag}> inside component ${selected.component}`
    : `<${selected.tag}>`;
  const lineText =
    target.line > 0 ? (source.split("\n")[target.line - 1]?.trim() ?? "") : "";
  return [
    `File: ${target.file}`,
    target.line > 0
      ? `Selected element: ${name}, at line ${target.line} (the JSX opening tag starts there).`
      : `Selected element: ${name}.`,
    lineText ? `That line reads: ${lineText}` : null,
    selected.instanceCount > 1
      ? `Note: this source element renders ${selected.instanceCount} DOM instances (e.g. a .map() loop) — the edit affects all of them.`
      : null,
    ``,
    `Instruction: ${instruction}`,
    ``,
    `Current file content:`,
    "```tsx",
    source,
    "```",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** A prior turn passed back to the model as conversation memory. Only the
 * message texts travel — never past file snapshots (the current file is
 * always sent fresh in the final prompt). */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** One prompt through the active backend, with conversation memory. */
export async function runChatPrompt(
  backend: AiBackend,
  userPrompt: string,
  history: ChatTurn[] = [],
): Promise<string> {
  if (backend.kind === "cli") {
    // Headless CLI is single-shot — embed the transcript in the prompt.
    const transcript =
      history.length > 0
        ? `Conversation so far (context only — act on the final instruction):\n${history
            .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`)
            .join("\n")}\n\n`
        : "";
    return backend.run(`${SYSTEM_PROMPT}\n\n${transcript}${userPrompt}`);
  }

  // API: real message turns. Merge consecutive same-role entries and make
  // sure the transcript starts with a user turn (API requirements).
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of history) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.text}`;
    else messages.push({ role: m.role, content: m.text });
  }
  while (messages[0]?.role === "assistant") messages.shift();
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content += `\n\n${userPrompt}`;
  else messages.push({ role: "user", content: userPrompt });

  const client = new Anthropic({
    apiKey: backend.apiKey,
    dangerouslyAllowBrowser: true,
  });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages,
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("chat returned no text content");
  }
  return text.text;
}
