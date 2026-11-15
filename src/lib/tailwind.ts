// Tailwind class ⇄ control mapping (FR-3.2–3.6). Operates on the base
// (unprefixed) classes only — variant-prefixed tokens (hover:, dark:, md:…)
// pass through untouched, preserving their original positions.

import { twMerge } from "tailwind-merge";

export type Tokens = string[];

export const toTokens = (className: string): Tokens =>
  className.split(/\s+/).filter(Boolean);

export const fromTokens = (tokens: Tokens): string => tokens.join(" ");

const isVariant = (t: string) => t.includes(":");

/** Read the effective value for a single-token knob: last base token wins. */
export function readKnob(tokens: Tokens, re: RegExp): string | null {
  let value: string | null = null;
  for (const t of tokens) {
    if (isVariant(t)) continue;
    const m = t.match(re);
    if (m) value = m[1] ?? t;
  }
  return value;
}

/** Set a single-token knob: replace the first match in place, drop any other
 * matches, append when absent. `null` removes the knob entirely. */
export function setKnob(tokens: Tokens, re: RegExp, next: string | null): Tokens {
  const out: Tokens = [];
  let placed = false;
  for (const t of tokens) {
    if (!isVariant(t) && re.test(t)) {
      if (!placed && next !== null) {
        out.push(next);
        placed = true;
      }
      continue; // drop duplicates / removed knob
    }
    out.push(t);
  }
  if (!placed && next !== null) out.push(next);
  return out;
}

/**
 * Resolve conflicting utilities in a class string, keeping the last one of
 * each group — what Tailwind's own generated CSS effectively does, but visible
 * in the source instead of hidden in specificity.
 *
 * The knob controls above don't need this (each knob owns its regex and edits
 * in place); it is for class strings that arrive whole: the raw Classes field,
 * text pasted from elsewhere, and markup produced by the AI chat.
 *
 * `bg-*` gets a second pass because tailwind-merge treats background colour,
 * size, position, repeat and attachment as one group — so `bg-cover` would
 * eat `bg-red-500`. They are independent properties; only same-property
 * duplicates should collapse.
 */
export function mergeClasses(...parts: string[]): string {
  const merged = twMerge(...parts);
  const groups: Record<string, string[]> = {};
  const out: string[] = [];
  for (const token of merged.split(/\s+/).filter(Boolean)) {
    const group = bgGroupOf(token);
    if (!group) {
      out.push(token);
      continue;
    }
    (groups[group] ??= []).push(token);
  }
  // Last of each background group wins, in first-appearance order.
  for (const list of Object.values(groups)) out.push(list[list.length - 1]);
  return twMerge(out.join(" "));
}

const BG_GROUPS: Record<string, RegExp> = {
  repeat: /^bg-(?:repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/,
  size: /^bg-(?:auto|cover|contain)$/,
  position: /^bg-(?:bottom|center|left|right|top|left-bottom|left-top|right-bottom|right-top)$/,
  attachment: /^bg-(?:fixed|local|scroll)$/,
  // Anything else `bg-*` is a colour (named, arbitrary, or a theme token).
  color: /^bg-\S+$/,
};

function bgGroupOf(token: string): string | null {
  if (!token.startsWith("bg-")) return null;
  for (const [group, re] of Object.entries(BG_GROUPS)) {
    if (re.test(token)) return group;
  }
  return null;
}

// --- spacing (padding / margin) ---------------------------------------------

export interface Sides {
  t: string | null;
  r: string | null;
  b: string | null;
  l: string | null;
}

/** Resolve per-side spacing the way Tailwind's generated CSS does:
 * individual side beats axis beats all, regardless of class order;
 * within the same granularity the later token wins. */
export function readSpacing(tokens: Tokens, prefix: "p" | "m"): Sides {
  const value: Sides = { t: null, r: null, b: null, l: null };
  const rank = { t: 0, r: 0, b: 0, l: 0 };
  const re = new RegExp(`^(-?)${prefix}(t|r|b|l|x|y)?-(.+)$`);
  for (const token of tokens) {
    if (isVariant(token)) continue;
    const m = token.match(re);
    if (!m) continue;
    const v = (m[1] === "-" ? "-" : "") + m[3];
    const side = m[2];
    const apply = (keys: Array<keyof Sides>, granularity: number) => {
      for (const k of keys) {
        if (granularity >= rank[k]) {
          value[k] = v;
          rank[k] = granularity;
        }
      }
    };
    if (!side) apply(["t", "r", "b", "l"], 1);
    else if (side === "x") apply(["l", "r"], 2);
    else if (side === "y") apply(["t", "b"], 2);
    else apply([side as keyof Sides], 3);
  }
  return value;
}

/** Replace all base spacing tokens for `prefix` with a minimal set expressing
 * `sides` (p-4 / px-2 py-4 / pt-1 pr-2 …). Insertion point = first old token. */
export function writeSpacing(tokens: Tokens, prefix: "p" | "m", sides: Sides): Tokens {
  const re = new RegExp(`^-?${prefix}(t|r|b|l|x|y)?-(.+)$`);
  const mk = (suffix: string, v: string) =>
    v.startsWith("-")
      ? `-${prefix}${suffix}-${v.slice(1)}`
      : `${prefix}${suffix}-${v}`;

  const next: string[] = [];
  const { t, r, b, l } = sides;
  if (t !== null && t === b && l !== null && l === r && t === l) {
    next.push(mk("", t));
  } else {
    if (t !== null && t === b) next.push(mk("y", t));
    else {
      if (t !== null) next.push(mk("t", t));
      if (b !== null) next.push(mk("b", b));
    }
    if (l !== null && l === r) next.push(mk("x", l));
    else {
      if (l !== null) next.push(mk("l", l));
      if (r !== null) next.push(mk("r", r));
    }
  }

  const out: Tokens = [];
  let placed = false;
  for (const token of tokens) {
    if (!isVariant(token) && re.test(token)) {
      if (!placed) {
        out.push(...next);
        placed = true;
      }
      continue;
    }
    out.push(token);
  }
  if (!placed) out.push(...next);
  return out;
}

// --- knob definitions ---------------------------------------------------------

export const FONT_SIZES = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];
const FONT_SIZE_ALT = FONT_SIZES.join("|");

export const KNOBS = {
  display: /^(block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents|hidden)$/,
  flexDirection: /^flex-(row|row-reverse|col|col-reverse)$/,
  justify: /^justify-(start|end|center|between|around|evenly|stretch)$/,
  items: /^items-(start|end|center|baseline|stretch)$/,
  gap: /^gap-(.+)$/,
  width: /^w-(.+)$/,
  height: /^h-(.+)$/,
  minWidth: /^min-w-(.+)$/,
  maxWidth: /^max-w-(.+)$/,
  minHeight: /^min-h-(.+)$/,
  maxHeight: /^max-h-(.+)$/,
  fontSize: new RegExp(`^text-(${FONT_SIZE_ALT}|\\[(?!#|rgb|hsl|var)[^\\]]+\\])$`),
  fontWeight: /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/,
  textAlign: /^text-(left|center|right|justify)$/,
  textColor: new RegExp(
    `^text-(?!(?:${FONT_SIZE_ALT}|left|center|right|justify)$)((?!\\[(?!#|rgb|hsl|var)).+)$`,
  ),
  leading: /^leading-(.+)$/,
  tracking: /^tracking-(.+)$/,
  background: /^bg-(.+)$/,
  borderWidth: /^border(?:-(0|2|4|8))?$/,
  borderColor: /^border-((?:[a-z]+-(?:50|[1-9]00|950))|black|white|transparent|current|inherit|\[[^\]]+\])$/,
  radius: /^rounded(?:-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full|\[[^\]]+\]))?$/,
  shadow: /^shadow(?:-(2xs|xs|sm|md|lg|xl|2xl|none|inner|\[[^\]]+\]))?$/,
} as const;

/** Tailwind's default spacing scale, for steppers. */
export const SPACING_SCALE = [
  "0", "px", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6", "7",
  "8", "9", "10", "11", "12", "14", "16", "20", "24", "28", "32", "36", "40",
  "44", "48", "52", "56", "60", "64", "72", "80", "96",
];

/** Step an arbitrary spacing value along the scale; arbitrary values ([13px])
 * or off-scale values step onto the nearest scale entry. */
export function stepSpacing(value: string | null, dir: 1 | -1): string {
  if (value === null) return dir === 1 ? "1" : "0";
  const i = SPACING_SCALE.indexOf(value);
  if (i === -1) return value; // arbitrary — let the user type
  const next = Math.min(SPACING_SCALE.length - 1, Math.max(0, i + dir));
  return SPACING_SCALE[next];
}

/**
 * The class for a dragged pixel size — always an arbitrary value.
 *
 * Snapping to the spacing scale (`w-64` for 256px) would read better, and is
 * wrong: Tailwind v4's scale is a multiple of `--spacing`, which a project can
 * redefine. Snapping under an assumed 4px step would silently resize the
 * element to something other than what was dragged, and "silently a different
 * size" is the one outcome a direct-manipulation gesture must never produce.
 * An arbitrary value is exactly the size the user dragged, in every project.
 * The inspector's Size steppers are there to convert it to a scale value.
 */
export function sizeClass(
  axis: "w" | "h",
  px: number,
): string {
  return `${axis}-[${Math.max(0, Math.round(px))}px]`;
}

/** Resolve a Tailwind colour token (the part after `bg-`/`text-`/`border-`) to
 * something CSS can paint, for the inspector's swatches. Palette names ride the
 * app's own `--color-*` theme vars (styles.css imports the theme `static` so
 * they all exist); arbitrary values pass through. Returns null when the token
 * isn't a colour we can resolve — callers render that state honestly rather
 * than guessing. */
export function cssColor(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).replace(/_/g, " ");
    return /^(#|rgb|hsl|oklch|lab|color\()/i.test(inner) ? inner : null;
  }
  if (v === "transparent" || v === "black" || v === "white") return v;
  if (/^[a-z]+-(?:50|[1-9]00|950)$/.test(v)) return `var(--color-${v}, transparent)`;
  return null;
}

/**
 * The colour the page actually painted for a colour token, when it is known.
 *
 * `cssColor` can only resolve what the editor's own theme knows: the stock
 * palette and arbitrary values. A project token — `bg-primary`, `text-muted`,
 * anything with an opacity suffix, or a palette name the project redefined —
 * resolves only inside the page, so the overlay reports the computed colours
 * with the selection.
 *
 * That report is a snapshot, and it is trusted only for the class it was
 * taken with: once the user stages a different fill, the snapshot describes
 * the old one, and the token's own resolution (or nothing) is the honest
 * answer until the element is selected again.
 */
export function pageColor(
  token: string | null,
  prefix: "bg" | "text" | "border",
  el: {
    domClassName: string;
    colors?: { background: string | null; text: string | null; border: string | null };
  } | null,
): string | null {
  if (!token || !el?.colors) return null;
  if (!el.domClassName.split(/\s+/).includes(`${prefix}-${token}`)) return null;
  const css =
    prefix === "bg" ? el.colors.background : prefix === "text" ? el.colors.text : el.colors.border;
  return css || null;
}
