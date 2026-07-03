// Tailwind class ⇄ control mapping (FR-3.2–3.6). Operates on the base
// (unprefixed) classes only — variant-prefixed tokens (hover:, dark:, md:…)
// pass through untouched, preserving their original positions.

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
