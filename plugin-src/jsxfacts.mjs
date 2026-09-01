// The facts two detectors read off a JSX node, and the arithmetic they score
// with — one definition, because they must agree exactly.
//
// `scan.mjs` compares whole named components to each other. `extract.mjs`
// compares repeated subtrees *inside* them. If the two disagreed about what an
// element's tag is, which of its classes are static, or what `p-4` and `p-6`
// have in common, the same markup would be a duplicate to one and not to the
// other — and a user looking at both tabs would be told two different things
// about one button. (This is the same rule `jsxwalk.mjs` holds for element
// ids: one traversal, never forked.)
//
// It lives in its own module rather than being imported from `scan.mjs`
// because each detector is bundled as its own sidecar, and both bundles end
// with a `isMainModule` stdin loop. Importing one from the other inlines that
// loop into the wrong bundle, where it is main, and two handlers then answer
// one request on one stdout.

/** Tailwind's colour names — the value half of `bg-red-500`, `text-white`. */
export const COLOR_NAMES = new Set(
  ("slate gray zinc neutral stone red orange amber yellow lime green emerald " +
    "teal cyan sky blue indigo violet purple fuchsia pink rose black white " +
    "transparent current inherit").split(" "),
);

/**
 * Reduce a Tailwind token to its "knob" so `p-4`/`p-6` (and `bg-red-500` /
 * `bg-blue-600`) compare as the same control set to a different value.
 * Variants are kept, so `hover:bg-red-500` is a different knob from `bg-*`.
 */
export function knobOf(token) {
  const sep = token.lastIndexOf(":");
  const variant = sep >= 0 ? token.slice(0, sep + 1) : "";
  let base = sep >= 0 ? token.slice(sep + 1) : token;
  if (base.startsWith("-")) base = base.slice(1);
  base = base.replace(/-\[[^\]]*\]$/, ""); // arbitrary values are just values
  const parts = base.split("-");
  if (parts.length >= 2) {
    if (COLOR_NAMES.has(parts[1])) return `${variant}${parts[0]}-color`;
    const last = parts[parts.length - 1];
    if (/^(\d+(\.\d+)?|\d+\/\d+|px|full|none|auto|xs|sm|md|lg|xl|\d+xl)$/.test(last)) {
      return variant + parts.slice(0, -1).join("-");
    }
  }
  return variant + base;
}

/** The knob without its variant prefix — what `LAYOUT_KNOBS` is keyed on. */
export function baseKnob(knob) {
  const sep = knob.lastIndexOf(":");
  return sep >= 0 ? knob.slice(sep + 1) : knob;
}

/**
 * Knobs that position an element inside its parent, as opposed to styling the
 * element itself.
 *
 * The distinction earns its place in the extractor: two buttons that differ
 * only in `bg-blue-600` vs `bg-red-600` differ in what they *are*, and that is
 * a variant. Two that differ only in `mt-4` differ in where they were *put*,
 * and baking that into a shared component makes it fight every later use. So
 * a varying layout knob stays at the call site; a varying visual one becomes
 * part of the component's API.
 */
export const LAYOUT_KNOBS = new Set([
  "m", "mt", "mr", "mb", "ml", "mx", "my", "ms", "me",
  "w", "h", "min-w", "max-w", "min-h", "max-h", "size",
  "flex", "grow", "shrink", "basis", "order",
  "col-span", "col-start", "col-end", "row-span", "row-start", "row-end",
  "absolute", "relative", "fixed", "sticky", "static",
  "top", "right", "bottom", "left", "inset", "z",
  "self", "justify-self", "place-self", "float", "clear",
  "translate", "translate-x", "translate-y",
]);

export const isLayoutKnob = (knob) => LAYOUT_KNOBS.has(baseKnob(knob));

/** The tag as written: `div`, `Foo.Bar`, `svg:use`. */
export function jsxTagName(name) {
  if (!name) return "?";
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    return `${jsxTagName(name.object)}.${name.property?.name ?? "?"}`;
  }
  if (name.type === "JSXNamespacedName") {
    return `${name.namespace?.name}:${name.name?.name}`;
  }
  return "?";
}

/** Static class tokens of a JSX opening element ([] when absent/dynamic). */
export function staticClassTokens(opening) {
  const attr = opening.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name?.name === "className",
  );
  if (!attr?.value) return [];
  let value = null;
  if (attr.value.type === "StringLiteral") value = attr.value.value;
  else if (attr.value.type === "JSXExpressionContainer") {
    const e = attr.value.expression;
    if (e.type === "StringLiteral") value = e.value;
    else if (e.type === "TemplateLiteral" && e.expressions.length === 0) {
      value = e.quasis[0].value.cooked ?? e.quasis[0].value.raw;
    }
  }
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

/** Set overlap, or null when both sides are empty (no evidence, not zero). */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return null;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** djb2 — the id hash the scan's clusters already use. */
export function djb2(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
