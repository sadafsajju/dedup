// The chat composer's prompt history (src/lib/promptHistory).
// Run: pnpm test:prompts
//
// Arrow keys in a multi-line textarea are shared between two jobs — moving the
// caret and recalling a prompt — and the rule for which one gets the keystroke
// is invisible in a screenshot. So it is pinned here, along with the thing
// that would be worst to get wrong: a half-written draft disappearing because
// someone pressed ↑ to look at what they sent last.
import assert from "node:assert/strict";
import { promptsFrom, stepHistory } from "../src/lib/promptHistory.ts";
import type { HistoryState } from "../src/lib/promptHistory.ts";
import type { ChatMessage } from "../src/lib/types.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const msg = (role: "user" | "assistant", text: string): ChatMessage => ({
  id: `${role}-${text}`,
  role,
  text,
});

/** Both edges free — a one-line draft, which is the ordinary case. */
const edges = { atFirstLine: true, atLastLine: true };
const up = { key: "ArrowUp", ...edges };
const down = { key: "ArrowDown", ...edges };
const composing = (draft = ""): HistoryState => ({ at: null, stash: "", draft });

test("history is this chat's prompts, newest first", () => {
  const chat = [
    msg("user", "make it blue"),
    msg("assistant", "done"),
    msg("user", "now bigger"),
  ];
  assert.deepEqual(promptsFrom(chat), ["now bigger", "make it blue"]);
  // The model's replies are not prompts, and neither is an empty one.
  assert.deepEqual(promptsFrom([msg("assistant", "hello"), msg("user", "  ")]), []);
});

test("a prompt sent twice in a row appears once", () => {
  // Pressing ↑ twice and getting the same line back reads as a dropped key.
  const twice = promptsFrom([
    msg("user", "retry"),
    msg("assistant", "failed"),
    msg("user", "retry"),
    msg("user", "something else"),
  ]);
  assert.deepEqual(twice, ["something else", "retry"]);
  // But a prompt returned to after others keeps its place in the walk.
  const apart = promptsFrom([
    msg("user", "a"),
    msg("user", "b"),
    msg("user", "a"),
  ]);
  assert.deepEqual(apart, ["a", "b", "a"]);
});

test("↑ walks back, and stops at the oldest instead of letting the caret go", () => {
  const history = ["newest", "older", "oldest"];
  const first = stepHistory(composing(), history, up);
  assert.deepEqual(first, { at: 0, stash: "", draft: "newest" });

  const second = stepHistory(first as HistoryState, history, up);
  assert.equal(second?.draft, "older");
  const third = stepHistory(second as HistoryState, history, up);
  assert.equal(third?.draft, "oldest");

  // At the end of the history the key is still ours — swallowed, not passed
  // on, because a caret jumping to the top of the box reads as a recall that
  // silently failed.
  const past = stepHistory(third as HistoryState, history, up);
  assert.deepEqual(past, third, "the state must not move, and must be handled");
  assert.notEqual(past, null);
});

test("↓ comes back, and the last step returns the draft that was interrupted", () => {
  const history = ["newest", "older"];
  const start = composing("half-written thought");
  const at1 = stepHistory(start, history, up) as HistoryState;
  const at2 = stepHistory(at1, history, up) as HistoryState;
  assert.equal(at2.draft, "older");
  // The draft is not lost while walking — it is carried along.
  assert.equal(at2.stash, "half-written thought");

  const back = stepHistory(at2, history, down) as HistoryState;
  assert.equal(back.draft, "newest");
  const out = stepHistory(back, history, down) as HistoryState;
  assert.deepEqual(out, { at: null, stash: "", draft: "half-written thought" });
});

test("the caret keeps the keys whenever they are the caret's", () => {
  const history = ["newest"];
  // Mid-draft: ↑ moves the caret up a line, or the box cannot be edited.
  assert.equal(
    stepHistory(composing("two\nlines"), history, {
      key: "ArrowUp",
      atFirstLine: false,
      atLastLine: true,
    }),
    null,
  );
  // ↓ while not walking is always the caret's, at either edge.
  assert.equal(stepHistory(composing("x"), history, down), null);
  // …and while walking it is only ours from the last line.
  const walking = stepHistory(composing(), history, up) as HistoryState;
  assert.equal(
    stepHistory(walking, history, { key: "ArrowDown", atFirstLine: true, atLastLine: false }),
    null,
  );
  // Nothing to recall: ↑ is the caret's too.
  assert.equal(stepHistory(composing(), [], up), null);
  // And any other key is never ours.
  assert.equal(stepHistory(composing(), history, { key: "Enter", ...edges }), null);
});

test("an edit made to a recalled prompt survives the next walk", () => {
  // The panel drops out of the walk on any keystroke that types, so an edited
  // recall is an ordinary draft again — and the next ↑ stashes it like one.
  // The alternative loses work with no way back, which is the failure this
  // whole state machine exists to avoid.
  const history = ["newest", "older"];
  const edited = composing("newest, but with my changes");
  const next = stepHistory(edited, history, up) as HistoryState;
  assert.equal(next.stash, "newest, but with my changes");
  const out = stepHistory(next, history, down) as HistoryState;
  assert.equal(out.draft, "newest, but with my changes");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
