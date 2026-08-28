// The merge proposal (FR-5.4): what the model is asked, and how its answer is
// read back.
//
// The division of labour is the whole point. The model does the one thing
// static analysis cannot — decide what the *right* API for a merged component
// is, and write it. It is never trusted with anything else: it does not touch
// call sites (the codemod does that from a prop map, mechanically), it does
// not decide what may be deleted, and its output is parsed, validated, and
// re-parsed by the sidecar before a byte is written.
//
// Everything the model says is therefore either (a) a component source that
// must parse and must export the promised name, or (b) a prop map whose values
// are validated against a narrow whitelist. Nothing else it emits can reach
// the user's codebase.

import type { AiBackend } from "./categorize";
import type { MergePlan, MergeProposal } from "./types";

const SYSTEM_PROMPT = `You are an expert React + Tailwind engineer working inside "dedup", a tool that merges near-duplicate components. You are given several components that a deterministic scan found to be near-identical, plus how each one is used. Design the single canonical component that replaces them.

Design rules:
- Prefer ONE \`variant\` union prop with a class map (a plain \`const styles = { … }\` object, or cva if the project already uses it) over a spread of boolean props. Boolean props are acceptable only for genuinely independent toggles.
- Every existing call site must be reproducible from the canonical component plus props. If a member cannot be reproduced, say so in NOTES instead of inventing an approximation.
- Keep the union of the members' props. Give each variant-specific prop a default so existing call sites keep working unchanged.
- Preserve behaviour: if the members differ in handlers, hooks or logic, keep all of it, gated by props. Never silently drop a call, a handler, or an effect.
- Match the project's own conventions — the members' import style, TypeScript usage, and formatting are your guide.
- Output the COMPLETE file content for the canonical component, including its imports. It must be valid on its own.

Reply format (strict — anything else is rejected):
FILE: <path the canonical component should live in>
NAME: <the exported component name>
SUMMARY: <one imperative line describing the API you chose>
\`\`\`tsx
<the complete file content>
\`\`\`
PROPS:
<MemberName>: <JSON object of the props a call site of that member now needs, e.g. {"variant":"product"}; use {} when none>
… one line per member, every member listed …
NOTES:
- <anything the reviewer must know; write "none" if there is nothing>`;

/** Everything the model needs, and nothing it doesn't. */
export function buildMergePrompt(plan: MergePlan): string {
  const parts: string[] = [];
  parts.push(
    `Merge these ${plan.members.length} components into one canonical component.`,
    "",
  );

  for (const m of plan.members) {
    parts.push(`--- ${m.name} (${m.file}, ${m.exportKind} export, ${m.callSites} call site${m.callSites === 1 ? "" : "s"}) ---`);
    parts.push("```tsx");
    parts.push(m.source);
    parts.push("```");
    if (m.behavior.hooks.length || m.behavior.handlers.length) {
      parts.push(
        `Behaviour: hooks [${m.behavior.hooks.join(", ") || "none"}], handlers [${
          m.behavior.handlers.join(", ") || "none"
        }]`,
      );
    }
    parts.push("");
  }

  if (plan.behaviorDiff.differs) {
    parts.push(
      "IMPORTANT — these members differ in behaviour, not only in markup:",
      plan.behaviorDiff.detail ?? "",
      "Keep every behaviour, gated by props. If that is not possible, say so in NOTES and do not approximate.",
      "",
    );
  }

  // Real call sites, so the proposed API is shaped by how the components are
  // actually used rather than by how they are declared.
  const shown = plan.callSites.slice(0, 40);
  if (shown.length > 0) {
    parts.push(`--- how they are used (${plan.callSites.length} call site${plan.callSites.length === 1 ? "" : "s"}) ---`);
    for (const s of shown) {
      parts.push(`${s.file}:${s.line}  ${s.text.split("\n")[0].trim()}`);
    }
    if (plan.callSites.length > shown.length) {
      parts.push(`…and ${plan.callSites.length - shown.length} more of the same shapes.`);
    }
    parts.push("");
  }

  parts.push(
    `Suggested home: ${plan.canonicalSuggestion.file} (it has the most call sites). Use a different path only if there is a clear reason.`,
    `The canonical component must be named \`${plan.canonicalSuggestion.name}\` unless a different name is obviously better.`,
    "",
    `List props for exactly these members: ${plan.members.map((m) => m.name).join(", ")}.`,
  );
  return parts.join("\n");
}

export async function runMergePrompt(
  backend: AiBackend,
  plan: MergePlan,
): Promise<string> {
  const prompt = buildMergePrompt(plan);
  if (backend.kind === "claude-code") {
    return backend.run(`${SYSTEM_PROMPT}\n\n${prompt}`);
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: backend.apiKey,
    dangerouslyAllowBrowser: true,
  });
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("the model returned no text");
  return text.text;
}

/** Props a call site may be given. Anything richer is a refusal, not a cast:
 * the codemod writes these into JSX, so the type IS the safety boundary. */
export type PropValue = string | number | boolean;

const FENCE_RE = /```(?:tsx?|jsx?|javascript|typescript)?\n([\s\S]*?)```/;

/**
 * Read the model's reply into a proposal. Throws with a precise reason on
 * anything malformed — a half-understood proposal is worse than none, because
 * the missing half is a member whose call sites would be rewritten wrong.
 */
export function parseMergeReply(reply: string, plan: MergePlan): MergeProposal {
  const file = matchField(reply, "FILE");
  const name = matchField(reply, "NAME");
  const summary = matchField(reply, "SUMMARY") ?? "";
  if (!file) throw new Error("the proposal named no FILE for the canonical component");
  if (!name) throw new Error("the proposal named no component NAME");
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`\`${name}\` is not a valid component name`);
  }
  if (file.startsWith("/") || file.includes("..")) {
    throw new Error(`refusing a canonical path outside the project: ${file}`);
  }

  const fence = FENCE_RE.exec(reply);
  if (!fence) throw new Error("the proposal contained no component source block");
  const source = fence[1].trimEnd() + "\n";
  if (!source.includes(name)) {
    throw new Error(`the proposed source never mentions \`${name}\``);
  }

  const mapping = parseProps(reply, plan);
  const notes = parseNotes(reply);
  return { name, file, source, mapping, summary, notes };
}

function matchField(reply: string, field: string): string | null {
  const m = new RegExp(`^\\s*${field}:\\s*(.+)$`, "m").exec(reply);
  return m ? m[1].trim().replace(/^[`"']|[`"']$/g, "") : null;
}

/**
 * The PROPS block, one member per line. Every member must appear: a member the
 * model forgot is a member whose call sites would be rewritten without the
 * props that make them look the same, which is a silent visual regression.
 */
function parseProps(reply: string, plan: MergePlan): MergeProposal["mapping"] {
  const block = /^[ \t]*PROPS:[ \t]*\n([\s\S]*)/m.exec(reply);
  let body = block?.[1] ?? "";
  const notesAt = /^[ \t]*NOTES:/m.exec(body);
  if (notesAt) body = body.slice(0, notesAt.index);
  const byName = new Map<string, Record<string, PropValue>>();

  for (const line of body.split("\n")) {
    const m = /^\s*[-*]?\s*([A-Za-z_$][\w$]*)\s*:\s*(\{[\s\S]*\}|none)\s*$/.exec(line);
    if (!m) continue;
    const [, member, raw] = m;
    if (raw === "none") {
      byName.set(member, {});
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`the props for \`${member}\` are not valid JSON: ${raw}`);
    }
    byName.set(member, validateProps(member, parsed));
  }

  const mapping: MergeProposal["mapping"] = [];
  const missing: string[] = [];
  for (const m of plan.members) {
    const props = byName.get(m.name);
    if (props === undefined) missing.push(m.name);
    else mapping.push({ name: m.name, file: m.file, props });
  }
  if (missing.length > 0) {
    throw new Error(
      `the proposal listed no props for ${missing.join(", ")} — every member has to be accounted for`,
    );
  }
  return mapping;
}

function validateProps(member: string, value: unknown): Record<string, PropValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the props for \`${member}\` are not an object`);
  }
  const out: Record<string, PropValue> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      throw new Error(`\`${key}\` is not a usable prop name (on ${member})`);
    }
    if (typeof v === "string") {
      // The codemod refuses these too; catching it here names the member.
      if (/["\\\n\r]/.test(v)) {
        throw new Error(`the value of \`${key}\` on ${member} can't be written into JSX`);
      }
      out[key] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    } else if (v === null) {
      continue; // "don't pass this prop"
    } else {
      throw new Error(
        `\`${key}\` on ${member} is a ${typeof v} — only strings, numbers and booleans can be written as a prop here`,
      );
    }
  }
  return out;
}

function parseNotes(reply: string): string[] {
  const block = /^[ \t]*NOTES:[ \t]*\n([\s\S]*)/m.exec(reply);
  if (!block) return [];
  return block[1]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l.length > 0 && l.toLowerCase() !== "none");
}
