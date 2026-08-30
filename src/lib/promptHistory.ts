// Walking back through prompts already sent — ↑/↓ in the chat composer.
//
// Pure, and separate from the panel, because it is a small state machine with
// edges that are easy to get subtly wrong and impossible to see in a
// screenshot: what happens at the oldest entry, what happens to a draft you
// had half-written when you started walking, and when the keys belong to the
// caret rather than to the history.
//
// That last one is the rule everything else hangs off. The composer is a
// textarea — Shift+Enter makes a new line — so inside a multi-line draft ↑
// means "move the caret up" and taking it would make the box impossible to
// edit. History moves only from the edges: ↑ on the first line, ↓ on the last.

import type { ChatMessage } from "./types";

/** Where the composer is in the walk. */
export interface HistoryState {
  /** null = composing something new; otherwise an index into the history,
   *  0 being the most recent prompt. */
  at: number | null;
  /** The draft the walk started from, returned when it ends. */
  stash: string;
  /** What the composer shows. */
  draft: string;
}

/** What the keystroke was, and where the caret was when it happened. */
export interface HistoryKey {
  key: string;
  /** Caret on the first logical line, with nothing selected. */
  atFirstLine: boolean;
  /** Caret on the last logical line, with nothing selected. */
  atLastLine: boolean;
}

/**
 * The prompts of one conversation, newest first.
 *
 * Consecutive repeats collapse: pressing ↑ twice and being handed the same
 * line reads as a key that didn't register, which is worse than a shorter
 * history. Non-consecutive repeats stay — coming back to a prompt after
 * others is a real place in the conversation.
 */
export function promptsFrom(messages: ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || m.text.trim() === "") continue;
    if (out[0] !== m.text) out.unshift(m.text);
  }
  return out;
}

/**
 * The next state for one keystroke, or null when the key is not ours and the
 * caret should do what it always does.
 *
 * A returned state that equals the one passed in means "ours, and nothing
 * changed" — the ↑ at the oldest entry, which is swallowed rather than let
 * through, because a caret jumping to the top of the box would read as the
 * recall having silently failed.
 */
export function stepHistory(
  state: HistoryState,
  history: string[],
  { key, atFirstLine, atLastLine }: HistoryKey,
): HistoryState | null {
  if (key === "ArrowUp") {
    if (!atFirstLine || history.length === 0) return null;
    const next = state.at === null ? 0 : state.at + 1;
    if (next >= history.length) return state; // already at the oldest
    return {
      at: next,
      // Whatever was in the box when the walk began — including something
      // edited out of a recalled prompt — is kept, so ↓ brings it back and no
      // keystroke ever destroys typing without a way to undo it.
      stash: state.at === null ? state.draft : state.stash,
      draft: history[next],
    };
  }

  if (key === "ArrowDown") {
    // Not walking: ↓ is the caret's, even on the last line.
    if (state.at === null || !atLastLine) return null;
    if (state.at === 0) return { at: null, stash: "", draft: state.stash };
    return { at: state.at - 1, stash: state.stash, draft: history[state.at - 1] };
  }

  return null;
}
