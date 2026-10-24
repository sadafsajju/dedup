// `@claude` / `@codex` in the chat composer: which agent a message goes to.
//
// Both agents can be connected at once — each Connect is its own consent — so
// choosing between them is a property of the *message*, not a global mode the
// user has to flip and remember to flip back. A message with no mention goes
// to the default (the top-bar AI switch); a message with one goes to that
// agent, for that message only.
//
// Pure so the edges can be tested (pnpm test:mentions): which `@` counts, what
// the model is sent once the mention is taken out, and where the caret is for
// the autocomplete. Every alias comes from CLI_AGENTS, so a third agent gets
// its mention by being a row there.

import { CLI_AGENTS } from "./types";
import type { CliAgent } from "./types";

/** What a message can call each agent: its id and its command, lowercased. */
function aliasesOf(agent: (typeof CLI_AGENTS)[number]): string[] {
  return [...new Set([agent.id, agent.command].map((a) => a.toLowerCase()))];
}

/** The alias the autocomplete writes — the command, because it is the short
 *  word the user already types in a terminal (`claude`, `codex`). */
export function mentionAlias(agent: CliAgent): string {
  return CLI_AGENTS.find((a) => a.id === agent)?.command ?? agent;
}

const ALIASES: { alias: string; agent: CliAgent }[] = CLI_AGENTS.flatMap((a) =>
  aliasesOf(a).map((alias) => ({ alias, agent: a.id })),
)
  // Longest first, so `@claude-code` is not read as `@claude` + "-code".
  .sort((x, y) => y.alias.length - x.alias.length);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * A mention is `@alias` at the start of the text or after whitespace, ending
 * at whitespace, the end, or sentence punctuation. Anything else is not one:
 * `@radix-ui/react-icons` is a package and `me@codex.dev` is an address, and
 * a chat about code mentions both often enough that mis-routing on them would
 * be a real failure rather than a theoretical one.
 */
const MENTION_RE = new RegExp(
  `(^|\\s)@(${ALIASES.map((a) => escape(a.alias)).join("|")})(?=$|[\\s.,:;!?)])`,
  "i",
);
const MENTION_RE_ALL = new RegExp(MENTION_RE.source, "gi");

function agentOf(alias: string): CliAgent {
  const hit = ALIASES.find((a) => a.alias === alias.toLowerCase());
  return (hit as { agent: CliAgent }).agent;
}

/**
 * Who this message is for, and what to send them.
 *
 * Only the **first** mention routes, and only it is taken out. A later one is
 * part of what the user is saying — "@claude, ask @codex for a hero image" —
 * and the model reads it as words. `instruction` is empty when the message was
 * nothing but a mention; the caller refuses that rather than sending a blank
 * prompt.
 */
export function routeMention(text: string): {
  agent: CliAgent | null;
  instruction: string;
} {
  const m = MENTION_RE.exec(text);
  if (!m) return { agent: null, instruction: text.trim() };
  const at = m.index + m[1].length;
  const before = text.slice(0, at).replace(/[ \t]+$/, "");
  // A vocative comma or colon belongs to the mention: "@codex, make it" asks
  // for "make it", not ", make it".
  const after = text.slice(at + 1 + m[2].length).replace(/^[,:;]?[ \t]*/, "");
  const joiner = before && after && !/\s$/.test(before) ? " " : "";
  return { agent: agentOf(m[2]), instruction: (before + joiner + after).trim() };
}

/** A sent message cut into runs, so the bubble can mark who it was sent to. */
export function splitMentions(
  text: string,
): { text: string; agent?: CliAgent }[] {
  const out: { text: string; agent?: CliAgent }[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE_ALL)) {
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: `@${m[2]}`, agent: agentOf(m[2]) });
    last = at + 1 + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The half-typed mention the caret is in: `text.slice(start, end)` is the
 *  `@word` the autocomplete would replace, `query` what is typed so far. */
export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

const WORD = /[A-Za-z-]/;

/**
 * The `@…` under the caret, if the caret is in one. Same boundary rule as a
 * sent mention — after whitespace or at the start — so the popup never opens
 * inside an email address or a package scope.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  let at = caret;
  while (at > 0 && WORD.test(text[at - 1])) at--;
  if (at === 0 || text[at - 1] !== "@") return null;
  const start = at - 1;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  let end = caret;
  while (end < text.length && WORD.test(text[end])) end++;
  return { start, end, query: text.slice(at, caret).toLowerCase() };
}

/** The agents a half-typed mention could mean, in CLI_AGENTS order. An empty
 *  query (just `@`) offers all of them. */
export function mentionCandidates(query: string): CliAgent[] {
  const q = query.toLowerCase();
  return CLI_AGENTS.filter(
    (a) =>
      aliasesOf(a).some((alias) => alias.startsWith(q)) ||
      a.label.toLowerCase().startsWith(q),
  ).map((a) => a.id);
}

/** Replace the half-typed mention with the agent's alias and a space, and say
 *  where the caret goes — after the space, ready for the instruction. */
export function insertMention(
  text: string,
  q: MentionQuery,
  agent: CliAgent,
): { text: string; caret: number } {
  const word = `@${mentionAlias(agent)}`;
  const rest = text.slice(q.end);
  const sep = rest.startsWith(" ") ? "" : " ";
  const next = text.slice(0, q.start) + word + sep + rest;
  return { text: next, caret: q.start + word.length + 1 };
}
