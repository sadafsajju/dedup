// Tests for `@agent` mentions in the chat composer.
// Run: pnpm test:mentions
import assert from "node:assert/strict";
import {
  insertMention,
  mentionAt,
  mentionCandidates,
  routeMention,
  splitMentions,
} from "../src/lib/mentions.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.error(`FAIL — ${name}\n${e}`);
  }
}

test("a leading mention routes the message and is taken out of it", () => {
  assert.deepEqual(routeMention("@codex make a hero image"), {
    agent: "codex",
    instruction: "make a hero image",
  });
  assert.deepEqual(routeMention("@claude tighten the nav"), {
    agent: "claude-code",
    instruction: "tighten the nav",
  });
});

test("every alias an agent has routes to it, whatever the case", () => {
  assert.equal(routeMention("@claude-code fix it").agent, "claude-code");
  assert.equal(routeMention("@Claude fix it").agent, "claude-code");
  assert.equal(routeMention("@CODEX fix it").agent, "codex");
});

test("the longer alias wins — @claude-code is not @claude plus '-code'", () => {
  assert.equal(routeMention("@claude-code fix it").instruction, "fix it");
});

test("a mention mid-sentence routes, and the sentence closes over the gap", () => {
  assert.deepEqual(routeMention("please @codex add an illustration"), {
    agent: "codex",
    instruction: "please add an illustration",
  });
});

test("a vocative comma or colon goes with the mention", () => {
  assert.equal(routeMention("@codex, make it pop").instruction, "make it pop");
  assert.equal(routeMention("@claude: why is this red?").instruction, "why is this red?");
});

test("no mention: no agent, and the text is untouched", () => {
  assert.deepEqual(routeMention("make the button bigger"), {
    agent: null,
    instruction: "make the button bigger",
  });
});

// The cases that would mis-route a real conversation about code.
test("a package scope is not a mention", () => {
  assert.equal(routeMention("bump @codex/sdk to v2").agent, null);
  assert.equal(routeMention("import from @claude-ai/x").agent, null);
});

test("an email address is not a mention", () => {
  assert.equal(routeMention("mail me@codex.dev").agent, null);
});

test("an unknown handle is left alone", () => {
  const r = routeMention("@gemini do it");
  assert.equal(r.agent, null);
  assert.equal(r.instruction, "@gemini do it");
});

test("only the first mention routes; a later one stays in what is said", () => {
  assert.deepEqual(routeMention("@claude ask @codex for a hero image"), {
    agent: "claude-code",
    instruction: "ask @codex for a hero image",
  });
});

test("a message that is only a mention has nothing to send", () => {
  assert.deepEqual(routeMention("@codex"), { agent: "codex", instruction: "" });
  assert.deepEqual(routeMention("  @codex  "), { agent: "codex", instruction: "" });
});

test("splitMentions marks every mention and round-trips the text", () => {
  const text = "@claude ask @codex, then me@codex.dev";
  const runs = splitMentions(text);
  assert.equal(runs.map((r) => r.text).join(""), text);
  assert.deepEqual(
    runs.filter((r) => r.agent).map((r) => [r.text, r.agent]),
    [
      ["@claude", "claude-code"],
      ["@codex", "codex"],
    ],
  );
});

test("mentionAt finds the half-typed mention under the caret", () => {
  assert.deepEqual(mentionAt("@co", 3), { start: 0, end: 3, query: "co" });
  assert.deepEqual(mentionAt("hi @", 4), { start: 3, end: 4, query: "" });
  // Caret mid-word: the whole word is what gets replaced.
  assert.deepEqual(mentionAt("@codex fix", 2), { start: 0, end: 6, query: "c" });
});

test("mentionAt stays shut inside an address or after the word ends", () => {
  assert.equal(mentionAt("me@co", 5), null);
  assert.equal(mentionAt("@codex fix", 10), null);
  assert.equal(mentionAt("no at sign", 5), null);
});

test("candidates: bare @ offers every agent; a prefix narrows it", () => {
  assert.deepEqual(mentionCandidates(""), ["claude-code", "codex"]);
  assert.deepEqual(mentionCandidates("c"), ["claude-code", "codex"]);
  assert.deepEqual(mentionCandidates("co"), ["codex"]);
  assert.deepEqual(mentionCandidates("cla"), ["claude-code"]);
  assert.deepEqual(mentionCandidates("x"), []);
});

test("insertMention writes the short alias and puts the caret after a space", () => {
  const text = "@co make a logo";
  const q = mentionAt(text, 3)!;
  assert.deepEqual(insertMention(text, q, "codex"), {
    text: "@codex make a logo",
    caret: 7,
  });
  const bare = mentionAt("@", 1)!;
  assert.deepEqual(insertMention("@", bare, "claude-code"), {
    text: "@claude ",
    caret: 8,
  });
});

test("what insertMention writes is what routeMention reads", () => {
  for (const agent of ["claude-code", "codex"] as const) {
    const q = mentionAt("@", 1)!;
    const { text } = insertMention("@", q, agent);
    assert.equal(routeMention(`${text}do it`).agent, agent);
  }
});

console.log(`\n${passed} passed`);
