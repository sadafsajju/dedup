// Insert palette — the small set of elements dedup can add to a page.
//
// Each entry carries two renderings of the same thing: the JSX that goes into
// the user's source, and the HTML the overlay puts on the canvas for the
// live preview before save. They are written side by side deliberately —
// deriving one from the other would mean shipping a JSX renderer into the
// overlay, and the two forms genuinely differ (className vs class).
//
// Deliberately plain markup: dedup inserts a neutral element the user then
// styles with the inspector, rather than guessing at a design.

export type InsertKind = "div" | "text" | "button" | "image";

export interface PaletteEntry {
  kind: InsertKind;
  label: string;
  /** Written to source (validated as a single JSX element by write-back). */
  snippet: string;
  /** Rendered into the canvas for the staged preview. */
  preview: string;
}

export const PALETTE: Record<InsertKind, PaletteEntry> = {
  div: {
    kind: "div",
    label: "Frame",
    snippet: '<div className="flex min-h-16 min-w-16 flex-col gap-2 rounded border border-dashed border-neutral-300 p-4" />',
    preview:
      '<div class="flex min-h-16 min-w-16 flex-col gap-2 rounded border border-dashed border-neutral-300 p-4"></div>',
  },
  text: {
    kind: "text",
    label: "Text",
    snippet: '<p className="text-base">Text</p>',
    preview: '<p class="text-base">Text</p>',
  },
  button: {
    kind: "button",
    label: "Button",
    snippet:
      '<button type="button" className="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white">Button</button>',
    preview:
      '<button type="button" class="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white">Button</button>',
  },
  image: {
    kind: "image",
    label: "Image",
    // A local placeholder would need a file in the user's project; an empty
    // src with alt text is honest about being a placeholder they must fill in.
    snippet: '<img src="" alt="" className="h-32 w-32 rounded bg-neutral-100 object-cover" />',
    preview: '<img src="" alt="" class="h-32 w-32 rounded bg-neutral-100 object-cover" />',
  },
};

export const PALETTE_ORDER: InsertKind[] = ["div", "text", "button", "image"];

// --- editing a staged insert -------------------------------------------------
//
// An inserted element has no source node yet, so its class and text edits have
// nowhere to land — they are folded back into the snippet, and the snippet is
// what gets written on save. That needs a way to rewrite one attribute or the
// text of a single element, in both spellings (JSX `className`, HTML `class`).
//
// This parses only markup this file authored: one element, quoted attributes,
// at most a plain text child. Anything else returns null and the caller
// refuses the edit — and the write-back re-parses whatever we produce before
// it can reach a file, so a bad rewrite fails closed rather than landing.

const SIMPLE_ELEMENT =
  /^<([A-Za-z][\w.]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>(?:([^<>{}]*)<\/[A-Za-z][\w.]*>)?$/;

export interface SimpleElement {
  tag: string;
  attrs: Array<[string, string]>;
  selfClosing: boolean;
  text: string | null;
}

export function parseSimpleElement(markup: string): SimpleElement | null {
  const m = markup.trim().match(SIMPLE_ELEMENT);
  if (!m) return null;
  const attrs: Array<[string, string]> = [
    ...m[2].matchAll(/([\w:.-]+)="([^"]*)"/g),
  ].map((a) => [a[1], a[2]]);
  return {
    tag: m[1],
    attrs,
    selfClosing: m[3] === "/",
    text: m[3] === "/" ? null : (m[4] ?? ""),
  };
}

export function serializeSimpleElement(el: SimpleElement): string {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${v}"`).join("");
  return el.selfClosing
    ? `<${el.tag}${attrs} />`
    : `<${el.tag}${attrs}>${el.text ?? ""}</${el.tag}>`;
}

/** Values that would break out of the attribute or the element. */
const UNSAFE = /["'`<>{}\\\n\r]/;

/** Rewrite one attribute (`className` in JSX, `class` in the preview HTML). */
export function withAttr(
  markup: string,
  name: string,
  value: string,
): string | null {
  if (UNSAFE.test(value)) return null;
  const el = parseSimpleElement(markup);
  if (!el) return null;
  const attrs = el.attrs.filter(([k]) => k !== name);
  if (value !== "") attrs.push([name, value]);
  return serializeSimpleElement({ ...el, attrs });
}

/** Rewrite the element's text child. Null when it can't hold text. */
export function withText(markup: string, text: string): string | null {
  if (UNSAFE.test(text)) return null;
  const el = parseSimpleElement(markup);
  if (!el || el.selfClosing) return null;
  return serializeSimpleElement({ ...el, text });
}

/** The classes a snippet currently carries (JSX spelling). */
export function classNameOf(markup: string): string {
  const el = parseSimpleElement(markup);
  return el?.attrs.find(([k]) => k === "className")?.[1] ?? "";
}

/** The text a snippet currently shows, or null when it holds none. */
export function textOf(markup: string): string | null {
  const el = parseSimpleElement(markup);
  return el && !el.selfClosing ? (el.text ?? "") : null;
}
