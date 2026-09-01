// The extraction proposal: what the model is asked when the user picks a set
// of drifted copies, and how its answer is read back.
//
// Same division of labour as `mergeProposal.ts`, and the same reason for it.
// Detection is deterministic — which copies exist, and exactly which knobs
// differ between them, was computed from the source before the model saw
// anything. What the model does is the one thing static analysis cannot: name
// the component and decide what its API should be.
//
// It is asked for *text*, and everything it can say is either a component
// source that must parse and export the promised name, or prose. It cannot
// name a path outside the project and it cannot reach the user's files: there
// is no write-back on this path at all yet, so a proposal is a proposal.
//
// One rule here that the merge doesn't need, because it is the whole reason
// drift is worth fixing: when copies have *drifted*, the model must pick one
// canonical value rather than preserve the spread as variants. Fifteen buttons
// with three paddings are not three sizes; they are one button and two
// accidents. Layout knobs are the exception, and the detector has already
// marked them.

import type { AiBackend } from "./categorize";
import type { DriftCandidate, DriftOccurrence } from "./types";

export interface ExtractionProposal {
  /** Where the canonical component should live, project-relative. */
  file: string;
  name: string;
  summary: string;
  /** Complete file content for the new component. */
  source: string;
  notes: string;
}

const SYSTEM_PROMPT = `You are an expert React + Tailwind engineer working inside "dedup". A deterministic scan found the same piece of markup written out several times across a codebase — copies that were never made into a component. You are given every copy and a precise report of what differs between them. Write the single component that replaces them.

Design rules:
- The copies have DRIFTED. Where a visual value differs (padding, radius, text size, opacity), that is almost always an accident, not an intention: pick ONE canonical value and say which in NOTES. Only introduce a \`variant\` prop when the difference is clearly meaningful — a different colour that maps to a real state (success/warning/danger) is a variant; three paddings are not three sizes.
- Knobs marked LAYOUT are the exception and must NOT move into the component. They are where a copy was placed, not what it is. Accept a \`className\` prop, append it last, and let the call site keep them.
- Everything listed as varying text or a varying attribute becomes a prop. Prefer \`children\` for the visible label.
- Match the project's conventions — the copies' own formatting, quoting and TypeScript usage are your guide.
- Output the COMPLETE file content, including imports. It must be valid on its own.

Reply format (strict — anything else is rejected):
FILE: <project-relative path the component should live in>
NAME: <the exported component name>
SUMMARY: <one imperative line describing the API you chose>
\`\`\`tsx
<the complete file content>
\`\`\`
NOTES:
- <which canonical values you picked and what you dropped; write "none" if there is nothing>`;

export function buildExtractPrompt(
  candidate: DriftCandidate,
  occurrences: DriftOccurrence[],
): string {
  const parts: string[] = [];
  parts.push(
    `These ${occurrences.length} copies of a \`<${candidate.tag}>\` are the same thing written out ${occurrences.length} times. Design the component that replaces them.`,
    "",
    "--- the copies ---",
  );
  for (const o of occurrences) {
    parts.push(`${o.file}:${o.line}${o.component ? ` (inside ${o.component})` : ""}`);
    parts.push("```tsx");
    parts.push(o.source);
    parts.push("```");
  }
  parts.push("");

  const shownIndex = new Map(
    candidate.occurrences.map((o, i) => [`${o.file}:${o.start}`, i]),
  );
  const picked = occurrences.map((o) => shownIndex.get(`${o.file}:${o.start}`)!);
  const at = (values: (string | null)[]) =>
    picked.map((i) => values[i] ?? "(absent)").join(", ");

  if (candidate.varies.classes.length > 0) {
    parts.push("--- what differs between them (computed, not guessed) ---");
    for (const v of candidate.varies.classes) {
      parts.push(
        `${v.layout ? "LAYOUT " : ""}${v.knob}: ${at(v.values)}`,
      );
    }
    parts.push("");
  }
  if (candidate.varies.attrs.length > 0) {
    parts.push("--- attributes that differ (these become props) ---");
    for (const a of candidate.varies.attrs) parts.push(`${a.name}: ${at(a.values)}`);
    parts.push("");
  }
  if (candidate.varies.texts.length > 0) {
    parts.push("--- text that differs ---");
    for (const t of candidate.varies.texts) parts.push(at(t.values));
    parts.push("");
  }
  if (candidate.existing) {
    parts.push(
      `NOTE: \`${candidate.existing.name}\` in ${candidate.existing.file} is already one of these copies. Prefer improving it in place over creating a second component — use that path and that name unless there is a clear reason not to.`,
      "",
    );
  }
  return parts.join("\n");
}

export async function runExtractPrompt(
  backend: AiBackend,
  candidate: DriftCandidate,
  occurrences: DriftOccurrence[],
): Promise<string> {
  const prompt = buildExtractPrompt(candidate, occurrences);
  if (backend.kind === "cli") {
    return backend.run(`${SYSTEM_PROMPT}\n\n${prompt}`);
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: backend.apiKey,
    dangerouslyAllowBrowser: true,
  });
  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

function matchField(reply: string, field: string): string | null {
  const m = reply.match(new RegExp(`^${field}:[ \\t]*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^[`"']|[`"']$/g, "") : null;
}

/** Strict — the same posture as `parseMergeReply`. Nothing here writes to the
 *  user's project, but a proposal the user cannot trust is worse than none. */
export function parseExtractReply(reply: string): ExtractionProposal {
  const file = matchField(reply, "FILE");
  const name = matchField(reply, "NAME");
  const summary = matchField(reply, "SUMMARY") ?? "";
  if (!file) throw new Error("the proposal named no FILE for the component");
  if (!name) throw new Error("the proposal named no component NAME");
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`\`${name}\` is not a valid component name`);
  }
  if (file.startsWith("/") || file.includes("..")) {
    throw new Error(`refusing a path outside the project: ${file}`);
  }
  const fence = reply.match(/```(?:tsx|jsx|ts|js)?\n([\s\S]*?)```/);
  if (!fence) throw new Error("the proposal contained no component source");
  const source = fence[1].trimEnd();
  // A source that never mentions the name it promised to export is the
  // cheapest possible catch for a reply that drifted from its own header.
  if (!source.includes(name)) {
    throw new Error(`the source never mentions \`${name}\``);
  }
  const notesIdx = reply.indexOf("NOTES:");
  const notes = notesIdx >= 0 ? reply.slice(notesIdx + 6).trim() : "";
  return { file, name, summary, source, notes };
}
