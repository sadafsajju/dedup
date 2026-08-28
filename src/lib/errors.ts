// Dev-server output → structured build errors.
//
// The console drawer already showed every line the dev server printed, which
// is the wrong granularity for the question the user actually has ("is my app
// broken right now, and why?"). A stderr line is not an error — Vite prints
// its banner there — and a compile error is many lines, not one.
//
// So: classify lines, group the consecutive ones into a single error, and drop
// the whole set the moment a successful compile is announced. That gives the
// editor a truthful "N errors" state to gate on (a save that breaks the build
// is visible immediately) and a block of text worth handing to the AI chat.

export interface ParsedError {
  id: string;
  /** Where it came from — the label shown on the error card. */
  source: string;
  /** The error text, newline-joined when it spans lines. */
  content: string;
  at: number;
}

/** Vite's own noise: progress, banners, and the dep-optimizer's chatter. */
const IGNORE = [
  /^\s*$/,
  /vite v?\d/i,
  /ready in \d/i,
  /hmr update/i,
  /page reload/i,
  /^\s*➜/,
  /optimized dependencies changed/i,
  /new dependencies optimized/i,
  /forced re-optimization/i,
];

/**
 * Lines that mean the build is broken. Deliberately a fixed list rather than
 * "anything on stderr": tools log warnings, deprecations and banners to stderr
 * constantly, and an error indicator that cries wolf is worse than none.
 */
const ERROR_PATTERNS = [
  // Compile / transform failures
  /Failed to compile/i,
  /Build failed/i,
  /\[plugin:[^\]]*\]/,
  /Internal server error/i,
  /Pre-transform error/i,
  /Transform failed/i,
  /Parse failure/i,
  // JS runtime + module resolution
  /\bSyntaxError\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bRangeError\b/,
  /Cannot find module/i,
  /Failed to resolve import/i,
  /Module not found/i,
  /ENOENT:/,
  // TypeScript
  /\bTS\d{4,5}:/,
  // Package managers / shell
  /npm ERR!/,
  /pnpm ERR!/,
  /yarn error/i,
  /command not found/i,
  /EADDRINUSE/,
];

/** A compile that succeeded — everything we were showing is now stale. */
const SUCCESS_PATTERNS = [
  /page reload/i,
  /hmr update/i,
  /ready in \d+\s*ms/i,
  /built in \d/i,
];

export function shouldIgnore(line: string): boolean {
  return IGNORE.some((re) => re.test(line));
}

export function isErrorLine(line: string): boolean {
  return ERROR_PATTERNS.some((re) => re.test(line));
}

export function isSuccessLine(line: string): boolean {
  return SUCCESS_PATTERNS.some((re) => re.test(line));
}

/** Continuation of the error above it: stack frames, carets, code frames. */
function isContinuation(line: string): boolean {
  return /^\s+/.test(line) || /^\s*(at |\||\^|>|\d+\s*\|)/.test(line);
}

const MAX_ERRORS = 20;
const MAX_LINES_PER_ERROR = 24;

/**
 * Fold one dev-server line into the current error list.
 *
 * Returns the same array when nothing changed, so callers can skip a state
 * update — this runs on every line of a chatty dev server.
 */
export function foldLine(
  errors: ParsedError[],
  line: string,
  source = "Dev server",
): ParsedError[] {
  // Dev servers colour their output; the escape sequence must not survive into
  // the error text (or into the prompt we hand to the AI).
  const text = line.replace(/\[[0-9;]*m/g, "").trimEnd();
  if (shouldIgnore(text)) {
    // A successful compile clears the board, even though the line itself is
    // noise we otherwise skip.
    return isSuccessLine(text) && errors.length > 0 ? [] : errors;
  }
  if (isSuccessLine(text)) return errors.length > 0 ? [] : errors;

  const last = errors[errors.length - 1];
  if (isErrorLine(text)) {
    // Same error repeated (dev servers re-print on every request) — keep one.
    if (errors.some((e) => e.content.split("\n")[0] === text)) return errors;
    const error: ParsedError = {
      id: `${Date.now()}-${errors.length}`,
      source,
      content: text,
      at: Date.now(),
    };
    return [...errors, error].slice(-MAX_ERRORS);
  }
  if (last && isContinuation(line) && Date.now() - last.at < 2000) {
    const lines = last.content.split("\n");
    if (lines.length >= MAX_LINES_PER_ERROR) return errors;
    const merged = { ...last, content: `${last.content}\n${text}` };
    return [...errors.slice(0, -1), merged];
  }
  return errors;
}

/** One-line summary for the console header. */
export function summarize(error: ParsedError): string {
  const first = error.content.split("\n")[0];
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}
