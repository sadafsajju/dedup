// Who a keystroke belongs to: the editor's own shortcuts, or a text field.
//
// Pure so it can be tested without a DOM (`pnpm test:keys`).

/** Something that takes typed text: an input, a textarea, or an editable
 * element. Read by tag name rather than `instanceof`, so it answers the same
 * for any element — including one from the canvas iframe's own realm. */
export function isTextEntry(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const n = el as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof n.tagName === "string" ? n.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || n.isContentEditable === true;
}

/**
 * Is the person typing into one of the editor's own fields — the chat
 * composer, a style input, a terminal — so a bare letter is text, not a tool
 * shortcut?
 *
 * The event's target alone cannot say: a keystroke the canvas overlay
 * forwards is replayed on `window`, so its target is never a field even when
 * the composer has focus. Taking the target alone sent letters typed into
 * the chat to the tool shortcuts (an `a` switched to Annotate mid-prompt).
 * The focused element settles it: while one of the editor's fields holds
 * focus, every bare keystroke is that field's. When the canvas has focus the
 * focused element is its `<iframe>`, which is not a field, so forwarded
 * shortcuts still work.
 */
export function typingInEditor(target: unknown, focused: unknown): boolean {
  return isTextEntry(target) || isTextEntry(focused);
}
