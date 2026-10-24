// The chat agent's model boundary: what dedup says to the backend, and in
// what shape it insists on hearing back.
//
// The agent is asked for *text*, never given tools or write access — dedup
// edits through its own parse-gated write-back, and a second path to the
// user's source would be an unaudited one. So the "tools" here are a protocol
// rather than a capability: the model asks in words for a file, a listing or
// a grep, dedup runs the read-only sidecar and hands the result back as the
// next turn. Everything the model can reach, dedup fetched on purpose.
//
// A canvas selection is context, not a gate. With one, the prompt says which
// element the user is pointing at; without one, the model starts from the
// project inventory and finds its own way — the same conversation either way.

import Anthropic from "@anthropic-ai/sdk";
import type { AiBackend } from "./categorize";
import type { SelectedElement } from "./types";

/**
 * The reply protocol. Identical whatever the language — the file's contents
 * are quoted verbatim either way — so only the engineer's brief and the
 * styling rule differ below. They differ because they have to: telling a model
 * editing a hand-written HTML page that it is a React engineer produces React.
 */
const PROTOCOL = `
You cannot open files yourself. dedup reads and writes them for you.

To see something you have not been given, reply with ONLY tool lines and no
other content:
TOOL: list
TOOL: read <project-relative path>
TOOL: grep <case-insensitive regex>
Several lines in one reply are fine; dedup runs them all and replies with the
results, and you continue from there. Ask for a file whenever you are not
certain of its exact current contents — an edit must quote the file
character-for-character, and you cannot quote a file you have not read.

Reply format when you are ready to change code (strict):
- One block per change, in exactly this form:
<<<<<<< SEARCH <project-relative path>
lines copied character-for-character from that file's current contents
=======
the replacement lines
>>>>>>> REPLACE
- The path after SEARCH is required whenever more than one file is in play. In
  a conversation about a single file you may leave it off.
- SEARCH must quote the file verbatim (indentation and spacing included) and
  must be unique within that file — include a neighbouring line or two when
  needed for uniqueness. Keep blocks small: only the lines that change plus
  what uniqueness requires.
- To add a whole new file:
<<<<<<< CREATE <project-relative path>
the complete contents of the new file
>>>>>>> END
- When you create a file, edit its call sites in the same reply. dedup applies
  every file in one all-or-nothing write, so a half-finished refactor is not a
  state the project can end up in.
- Write every path bare: no angle brackets, quotes or backticks around it.
  The <…> above marks where a value goes; it is not part of the value.
- After the last block, end with a single line "SUMMARY: <imperative one-liner
  of what changed>".
- If the instruction cannot be done safely, or it is a question needing no code
  change: reply in plain prose with NO blocks and NO tool lines.`;

/**
 * The one thing an agent can produce that cannot be typed out as text.
 *
 * Only added for a backend that actually generates files — inviting a
 * directive that always fails is worse than not having it, because the model
 * will reach for it and then have to explain itself to the user.
 */
const ASSET_PROTOCOL = `
- You can generate images. To put one you have generated into the project:
<<<<<<< ASSET <project-relative destination path>
the absolute path of the image file you generated
>>>>>>> END
  The block holds that one path and nothing else. dedup copies the file in
  itself, having checked that it is an image you generated and that the
  destination is inside the project — so use this only for a file you have
  just produced, never to read something else from the machine.
- Reference the image from your markup in the same reply, at the path the site
  will serve it from, and give it real alt text.`;

/**
 * The same capability for a backend that cannot generate images, borrowed from
 * a connected agent that can. Offered only when such an agent is connected —
 * the rule ASSET_PROTOCOL follows, for the same reason.
 *
 * The model describes the picture and names where it goes. It never names a
 * source path, so this widens nothing: the file still arrives as the other
 * agent's own ASSET import, through the same gates.
 */
const delegateProtocol = (agent: string) => `
- You cannot generate images yourself, but dedup can ask ${agent} to. To put a
  newly generated image into the project:
<<<<<<< IMAGE <project-relative destination path>
a precise description of the image: subject, style, palette, composition,
aspect ratio, and that it is for this page
>>>>>>> END
  Use a destination that does not exist yet, ending in .png — that is the
  format generated images arrive in. (If one arrives in another format, dedup
  renames the file and your references to it to match.) Use this only for an
  image that does not exist yet — never for one already in the project.
- Reference the image from your markup in the same reply, at the path the site
  will serve it from, and give it real alt text.`;

/**
 * What dedup asks the generating agent when another model wanted an image.
 * Strict on purpose: the answer goes through `pickGeneratedImage`, which takes
 * exactly one ASSET block and refuses anything else.
 */
export function imageRequestPrompt(file: string, description: string): string {
  return `Generate one image for a web project and do nothing else — do not read, write or change any other file.

The image will be saved in the project as: ${file}
What it should show:
${description}

When the image is generated, reply with ONLY this block, holding the absolute path of the file you generated, and nothing before or after it:
<<<<<<< ASSET ${file}
<absolute path of the generated image>
>>>>>>> END`;
}

const REACT_PROMPT = `You are an expert React + Tailwind engineer working inside "dedup", a visual code editor. The user is looking at their running app and has typed an instruction. They may or may not have an element selected on the canvas — when they have, it is named below; when they have not, work it out from the project.

Rules:
- Keep the change minimal and scoped to the instruction; preserve imports, formatting, comments, and unrelated code exactly as they are.
- Touch as few files as the instruction actually needs. Never add a dependency.
- Tailwind for styling; match each file's existing conventions.
${PROTOCOL}`;

const HTML_PROMPT = `You are an expert HTML and CSS engineer working inside "dedup", a visual code editor. The user is looking at their running site and has typed an instruction. They may or may not have an element selected on the canvas — when they have, it is named below; when they have not, work it out from the project.

Rules:
- Keep the change minimal and scoped to the instruction; preserve the document's structure, formatting, comments, and unrelated markup exactly as they are.
- Touch as few files as the instruction actually needs. No new script or stylesheet links, no new dependencies.
- Match each page's existing styling convention — if it uses Tailwind utility classes, use those; if it uses its own CSS classes, use those.
- Plain HTML: no JSX, no template syntax, no framework components.
${PROTOCOL}`;

/** Which brief this file gets. The extension is the whole decision. */
export function isHtmlFile(file: string): boolean {
  return /\.html?$/i.test(file);
}

/**
 * The brief for this turn. With a file in hand its extension decides; with
 * nothing selected the project's own framework does, because "static site"
 * is precisely the case where the React brief would be wrong.
 */
export function systemPromptFor(
  file: string | null,
  staticSite = false,
  /** Whether this backend generates files dedup can import (see ai.rs). */
  assets = false,
  /** When it doesn't: the label of a connected agent that does, which dedup
   *  will ask on its behalf. Ignored when `assets` is true — a backend that
   *  makes its own images has no reason to send for someone else's. */
  delegate: string | null = null,
): string {
  const base = file
    ? isHtmlFile(file)
      ? HTML_PROMPT
      : REACT_PROMPT
    : staticSite
      ? HTML_PROMPT
      : REACT_PROMPT;
  if (assets) return base + ASSET_PROTOCOL;
  return delegate ? base + delegateProtocol(delegate) : base;
}

/** One file dedup has put in front of the model, and why. */
export interface ChatAttachment {
  file: string;
  source: string;
  /** Present when this file is here because the user selected an element in
   *  it on the canvas. */
  element?: {
    selected: SelectedElement;
    /** Live line of the opening tag, from the write-back's inspect (0 when
     *  unknown — the prompt just omits the hint then). */
    line: number;
  };
}

function fence(file: string): string {
  return isHtmlFile(file) ? "html" : "tsx";
}

function attachmentBlock(a: ChatAttachment): string {
  const lines: string[] = [];
  if (a.element) {
    const { selected, line } = a.element;
    const name = selected.component
      ? `<${selected.tag}> inside component ${selected.component}`
      : `<${selected.tag}>`;
    const text = line > 0 ? (a.source.split("\n")[line - 1]?.trim() ?? "") : "";
    lines.push(
      line > 0
        ? `Selected on the canvas: ${name}, at ${a.file} line ${line} (the ${
            isHtmlFile(a.file) ? "start tag" : "JSX opening tag"
          } starts there).`
        : `Selected on the canvas: ${name}, in ${a.file}.`,
    );
    if (text) lines.push(`That line reads: ${text}`);
    if (selected.instanceCount > 1) {
      lines.push(
        `Note: this source element renders ${selected.instanceCount} DOM instances (e.g. a .map() loop) — an edit affects all of them.`,
      );
    }
    lines.push("");
  }
  lines.push(`File: ${a.file}`, "```" + fence(a.file), a.source, "```");
  return lines.join("\n");
}

/**
 * The user's turn. `attachments` is whatever dedup has already put in front of
 * the model — the selection's file at minimum, plus anything it asked to read.
 * `inventory` is the project's file list, sent once when there is no selection
 * so a cold conversation has somewhere to start instead of a blind grep.
 */
export function buildTurnPrompt(opts: {
  instruction: string;
  attachments: ChatAttachment[];
  inventory?: string[] | null;
  framework?: string | null;
  /** Notes the user wrote on the canvas next to marks they drew (lib/annotate).
   *  Context in exactly the same sense a selection is: it says what the user
   *  is looking at and what they think of it, and it is never a gate. */
  notes?: string[] | null;
}): string {
  const parts: string[] = [];
  if (opts.framework) parts.push(`Project type: ${opts.framework}.`);
  if (opts.inventory && opts.inventory.length > 0) {
    parts.push(
      `Project files (${opts.inventory.length}):\n${opts.inventory.join("\n")}`,
    );
  }
  if (opts.attachments.length === 0 && !opts.inventory) {
    parts.push(
      "Nothing is selected and no file has been read yet — use TOOL lines to find what you need.",
    );
  }
  for (const a of opts.attachments) parts.push(attachmentBlock(a));
  if (opts.notes && opts.notes.length > 0) {
    parts.push(
      `Marked up on the canvas (the user drew on the running app and wrote these; dedup does not know which element each mark covers, so treat them as the user's own words about that page):\n${opts.notes
        .map((n) => `- ${n}`)
        .join("\n")}`,
    );
  }
  parts.push(`Instruction: ${opts.instruction}`);
  return parts.join("\n\n");
}

/** One tool result, formatted as the turn dedup sends back. */
export function formatToolResult(
  tool: string,
  arg: string,
  body: string,
): string {
  const head = arg ? `${tool} ${arg}` : tool;
  return `Result of \`TOOL: ${head}\`:\n${body}`;
}

/** A prior turn passed back to the model as conversation memory. Only message
 *  texts travel — never past file snapshots (files are always sent fresh). */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** One prompt through the active backend, with conversation memory. */
export async function runChatPrompt(
  backend: AiBackend,
  userPrompt: string,
  history: ChatTurn[] = [],
  systemPrompt: string = REACT_PROMPT,
): Promise<string> {
  if (backend.kind === "cli") {
    // Headless CLI is single-shot — embed the transcript in the prompt.
    const transcript =
      history.length > 0
        ? `Conversation so far (context only — act on the final instruction):\n${history
            .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`)
            .join("\n")}\n\n`
        : "";
    return backend.run(`${systemPrompt}\n\n${transcript}${userPrompt}`);
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
    system: systemPrompt,
    messages,
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("chat returned no text content");
  }
  return text.text;
}
