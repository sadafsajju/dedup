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

/**
 * A colour that varies is the one visual difference that is usually meant.
 *
 * `knobOf` already names every colour utility `*-color` (`bg-red-500` →
 * `bg-color`), so this reads the detector's own classification rather than
 * inventing a second one. Variant-prefixed knobs are deliberately excluded:
 * a `hover:` or `focus:` colour that some copies have and others don't is a
 * missing state — drift of the most ordinary kind — and calling it semantic
 * would invite the model to turn "three of these forgot a hover" into a prop.
 * A state colour that really is meaningful still surfaces, through MOVE
 * TOGETHER with the base colour it tracks, which is the stronger signal.
 */
export const isColourKnob = (knob: string) =>
  /-color$/.test(knob) && !knob.includes(":");

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

A varying value is one of exactly three things, and the report tells you which:

1. DRIFT (unmarked) — padding, radius, text size, weight, opacity. Almost always an accident, not an intention. Pick ONE canonical value and say which in NOTES. Three paddings are not three sizes; they are one component and two mistakes.
2. LAYOUT (marked LAYOUT) — where a copy was *placed*, not what it is. These must NOT move into the component: accept a \`className\` prop, append it last, and let each call site keep its own.
3. SEMANTIC (marked SEMANTIC) — colour. A colour that changes with meaning is a real distinction, and collapsing it destroys information the UI was carrying. Give these a \`variant\`/\`tone\` union prop with a class map, one member per distinct combination, named for what it MEANS (success, warning, neutral) and never for the colour itself.

If the report says several knobs MOVE TOGETHER, that is one decision, not several: they are one variant prop whose members are the listed combinations. Never split co-varying knobs into separate props.
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

/** Which occurrences share a value, as a group index per occurrence. Two
 *  knobs with the same signature partition the copies identically. */
function partition(values: (string | null)[]): string {
  const seen = new Map<string, number>();
  return values
    .map((v) => {
      const k = v ?? "\u0000";
      if (!seen.has(k)) seen.set(k, seen.size);
      return seen.get(k)!;
    })
    .join(",");
}

/**
 * Knobs that vary *in lockstep* — `bg-color` slate/emerald/amber alongside
 * `text-color` slate/emerald/amber.
 *
 * This is the single strongest evidence that a difference is meaningful rather
 * than accidental. Nobody drifts two knobs into perfect agreement three times
 * over; that pattern is a set of named states somebody wrote on purpose. Left
 * as independent rows the model reads them as two more things to normalise,
 * and quietly deletes the distinction the UI was carrying — which is exactly
 * what it did to a badge whose three tones became one.
 */
export function covaryingGroups<T extends { knob: string; values: (string | null)[] }>(
  knobs: T[],
): T[][] {
  const bySignature = new Map<string, T[]>();
  for (const k of knobs) {
    // A knob with a single distinct value isn't varying, and one that differs
    // in every copy partitions nothing — neither is evidence of a state.
    const sig = partition(k.values);
    const distinct = new Set(sig.split(",")).size;
    if (distinct < 2 || distinct === k.values.length) continue;
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig)!.push(k);
  }
  return [...bySignature.values()].filter((g) => g.length > 1);
}

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
  const pick = (values: (string | null)[]) => picked.map((i) => values[i] ?? null);
  const at = (values: (string | null)[]) =>
    pick(values)
      .map((v) => v ?? "(absent)")
      .join(", ");

  if (candidate.varies.classes.length > 0) {
    parts.push("--- what differs between them (computed, not guessed) ---");
    for (const v of candidate.varies.classes) {
      const kind = v.layout ? "LAYOUT " : isColourKnob(v.knob) ? "SEMANTIC " : "";
      parts.push(`${kind}${v.knob}: ${at(v.values)}`);
    }
    parts.push("");

    // Restricted to the selection first: two knobs can agree across all
    // fifteen copies and disagree across the four the user actually kept.
    const picked = candidate.varies.classes.map((v) => ({
      knob: v.knob,
      layout: v.layout,
      values: pick(v.values),
    }));
    for (const group of covaryingGroups(picked.filter((v) => !v.layout))) {
      const names = group.map((g) => g.knob).join(" + ");
      parts.push(`MOVE TOGETHER: ${names} — one prop, not ${group.length}.`);
      const combos = new Map<string, number>();
      for (let i = 0; i < occurrences.length; i++) {
        const combo = group.map((g) => g.values[i] ?? "(absent)").join(" + ");
        combos.set(combo, (combos.get(combo) ?? 0) + 1);
      }
      for (const [combo, n] of combos) {
        parts.push(`  ${combo}  (${n} cop${n === 1 ? "y" : "ies"})`);
      }
      parts.push("");
    }
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
