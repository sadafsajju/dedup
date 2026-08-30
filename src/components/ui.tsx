// Figma-style inspector primitives (FR-6.5), following Figma's UI3 right panel:
// a bright normal-case section title with its actions on the right, small grey
// group captions stacked *above* their controls, and 28px filled fields.
//
// Honesty rule (PRD §"honesty over magic"): icons may replace labels, but every
// control still names the literal Tailwind class it writes in its `title`, so
// the panel keeps teaching the vocabulary instead of hiding it.
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "@radix-ui/react-icons";
import { cssColor } from "../lib/tailwind";

/** Structural shape of a Radix icon — narrow on purpose: the package's own
 * `IconProps` isn't re-exported from its entry point, and this is all we pass. */
export type IconType = React.ComponentType<{
  width?: number | string;
  height?: number | string;
  className?: string;
}>;

/**
 * Put text on the system clipboard, and say whether it landed.
 *
 * Two paths because either can be the one that works: `navigator.clipboard`
 * needs a secure context and can be refused outright, and the textarea +
 * `execCommand` route is deprecated and still the only thing left when it is.
 * Returns false rather than throwing, so a caller can leave its button alone
 * instead of showing a tick for a copy that never happened.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Refused or unavailable — try the old way before giving up.
  }
  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    // Off-screen but not display:none, which would make it unselectable.
    scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copy something, and show that it happened.
 *
 * The tick is the feature, not decoration: a clipboard write makes no sound
 * and changes nothing on screen, so a button that looks identical afterwards
 * reads as one that did nothing. It only appears when the write actually
 * succeeded.
 */
export function CopyButton({
  text,
  title = "Copy",
  className = "",
}: {
  text: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <button
      onClick={() => void copyText(text).then(setCopied)}
      title={copied ? "Copied" : title}
      aria-label={title}
      className={`shrink-0 rounded p-1 text-ink-faint hover:text-ink hover:bg-surface-2 ${
        copied ? "text-positive hover:text-positive" : ""
      } ${className}`}
    >
      <Icon width={11} height={11} />
    </button>
  );
}

// --- sections / groups -------------------------------------------------------

/** A titled block of the panel. Actions (add, disclose, toggle) sit on the
 * title's right, the way Figma hangs `+` off "Stroke" and "Effects". */
export function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-line px-3 py-3">
      <div className="flex h-6 items-center select-none">
        <span className="text-[13px] font-medium text-ink">{title}</span>
        <span className="flex-1" />
        <div className="flex items-center gap-0.5">{right}</div>
      </div>
      {children && <div className="mt-2 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

/** A labelled control group: grey caption above, controls below. */
export function Group({
  label,
  right,
  children,
}: {
  label?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {(label || right) && (
        <div className="flex h-4 items-center select-none">
          <span className="text-2xs text-ink-dim">{label}</span>
          <span className="flex-1" />
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/** Controls side by side on one line. */
export function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 items-center gap-2">{children}</div>;
}

/** Ghost button for a section or group header. */
export function IconButton({
  icon: Icon,
  active,
  title,
  onClick,
}: {
  icon: IconType;
  active?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
        active
          ? "bg-surface-3 text-ink"
          : "text-ink-dim hover:text-ink hover:bg-surface-2"
      }`}
    >
      <Icon width={14} height={14} />
    </button>
  );
}

// --- drag-to-scrub -----------------------------------------------------------

const SCRUB_PX = 5; // pointer travel per scale step

let scrubSeq = 0;

/** Figma's scrubbable field label: drag the prefix icon to step the value.
 * Each drag gets an id that the store uses to collapse the whole gesture into
 * one undo step. */
function useScrub(onScrub?: (dir: 1 | -1, group: string) => void) {
  const acc = useRef(0);
  const group = useRef("");
  if (!onScrub) return {};
  return {
    onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      acc.current = 0;
      group.current = `scrub-${++scrubSeq}`;
    },
    onPointerMove: (e: React.PointerEvent<HTMLSpanElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      acc.current += e.movementX;
      while (acc.current >= SCRUB_PX) {
        acc.current -= SCRUB_PX;
        onScrub(1, group.current);
      }
      while (acc.current <= -SCRUB_PX) {
        acc.current += SCRUB_PX;
        onScrub(-1, group.current);
      }
    },
    onPointerUp: (e: React.PointerEvent<HTMLSpanElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
  };
}

// --- fields ------------------------------------------------------------------

const SHELL =
  "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-transparent bg-surface-2 px-2 hover:border-line-strong focus-within:border-accent focus-within:hover:border-accent";

/** Text input that commits on Enter/blur only (undo stays coarse-grained). */
export function Field({
  icon: Icon,
  prefix,
  value,
  placeholder = "—",
  title,
  mono = true,
  onCommit,
  onScrub,
}: {
  icon?: IconType;
  prefix?: React.ReactNode;
  value: string;
  placeholder?: string;
  title?: string;
  mono?: boolean;
  onCommit: (v: string) => void;
  onScrub?: (dir: 1 | -1, group: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const scrub = useScrub(onScrub);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className={SHELL} title={title}>
      {prefix}
      {Icon && (
        <span
          {...scrub}
          className={`shrink-0 text-ink-faint ${
            onScrub ? "cursor-ew-resize hover:text-ink" : ""
          }`}
        >
          <Icon width={13} height={13} />
        </span>
      )}
      <input
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(value);
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
        className={`w-full min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}

export function Select({
  icon: Icon,
  value,
  options,
  onChange,
  title,
}: {
  icon?: IconType;
  value: string | null;
  options: Array<{ v: string; label?: string }>;
  onChange: (v: string | null) => void;
  title?: string;
}) {
  return (
    <div className={`${SHELL} relative`} title={title}>
      {Icon && <Icon width={13} height={13} className="shrink-0 text-ink-faint" />}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.currentTarget.value || null)}
        className="w-full min-w-0 appearance-none bg-transparent pr-4 text-xs text-ink outline-none"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label ?? o.v}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        width={12}
        height={12}
        className="pointer-events-none absolute right-1.5 text-ink-faint"
      />
    </div>
  );
}

/** Segmented icon group. Clicking the active segment clears the class. */
export function ToggleGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T | null;
  options: Array<{ v: T; icon: IconType; title: string }>;
  onChange: (v: T | null) => void;
}) {
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            title={o.title}
            onClick={() => onChange(active ? null : o.v)}
            className={`flex h-6 min-w-0 flex-1 items-center justify-center rounded-md ${
              active
                ? "bg-surface-3 text-ink ring-1 ring-line-strong"
                : "text-ink-dim hover:text-ink hover:bg-surface-3/60"
            }`}
          >
            <o.icon width={14} height={14} />
          </button>
        );
      })}
    </div>
  );
}

// --- colour swatch -----------------------------------------------------------

const CHECKER = {
  backgroundImage:
    "linear-gradient(45deg,#4a4a55 25%,transparent 25%,transparent 75%,#4a4a55 75%),linear-gradient(45deg,#4a4a55 25%,transparent 25%,transparent 75%,#4a4a55 75%)",
  backgroundSize: "6px 6px",
  backgroundPosition: "0 0,3px 3px",
} as const;

export function Swatch({ value }: { value: string | null }) {
  const css = cssColor(value);
  return (
    <span
      title={css ?? (value ? `${value} — not a resolvable colour` : "no colour")}
      style={css ? { background: css } : CHECKER}
      className="h-4 w-4 shrink-0 rounded ring-1 ring-inset ring-white/15"
    />
  );
}

// --- panel resizing ----------------------------------------------------------

/** Drag strip for a side panel's inner edge.
 *
 * Sits on top of the panel's hairline border and straddles it, so the target is
 * a comfortable 7px while the resting look stays a 1px line. Pointer capture is
 * what makes this work over the canvas: without it the dev-server iframe
 * swallows the move events the moment the cursor crosses into it. */
export function ResizeHandle({
  side,
  width,
  min,
  max,
  onResize,
  onReset,
  label,
}: {
  /** Which edge of the panel the handle lives on. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onResize: (px: number) => void;
  onReset: () => void;
  label: string;
}) {
  const drag = useRef<{ x: number; from: number } | null>(null);
  // Dragging right widens a left-hand panel but narrows a right-hand one.
  const sign = side === "right" ? 1 : -1;

  // Runs on pointerup *and* pointercancel: a cancelled gesture must not leave
  // the col-resize cursor stuck over the whole app.
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    document.body.style.cursor = "";
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, from: width };
        // Hold the cursor for the whole gesture, not just over the strip.
        document.body.style.cursor = "col-resize";
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(drag.current.from + (e.clientX - drag.current.x) * sign);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8;
        if (e.key === "ArrowLeft") onResize(width - step * sign);
        else if (e.key === "ArrowRight") onResize(width + step * sign);
        else return;
        e.preventDefault();
      }}
      className={`group absolute inset-y-0 z-20 w-1.5 cursor-col-resize select-none ${
        side === "right" ? "-right-[3px]" : "-left-[3px]"
      }`}
    >
      <span
        className={`pointer-events-none absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent ${
          side === "right" ? "right-[3px]" : "left-[3px]"
        }`}
      />
    </div>
  );
}
