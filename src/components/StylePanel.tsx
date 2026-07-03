// The Figma-style Tailwind controls (FR-3.2–3.6). Every control reads the
// effective class string, edits tokens through the mapping layer, and commits
// via applyClassEdit → staged + live canvas patch (FR-3.7).
import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import {
  fromTokens,
  KNOBS,
  readKnob,
  readSpacing,
  setKnob,
  stepSpacing,
  toTokens,
  writeSpacing,
  FONT_SIZES,
  type Sides,
  type Tokens,
} from "../lib/tailwind";

export function StylePanel({ className }: { className: string }) {
  const applyClassEdit = useStore((s) => s.applyClassEdit);
  const tokens = toTokens(className);
  const commit = (next: Tokens) => applyClassEdit(fromTokens(next));

  return (
    <>
      <LayoutSection tokens={tokens} commit={commit} />
      <SpacingSection tokens={tokens} commit={commit} />
      <SizeSection tokens={tokens} commit={commit} />
      <TypographySection tokens={tokens} commit={commit} />
      <FillSection tokens={tokens} commit={commit} />
      <ClassesField className={className} onCommit={applyClassEdit} />
    </>
  );
}

interface SectionProps {
  tokens: Tokens;
  commit: (next: Tokens) => void;
}

// --- primitives --------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 border-b border-line">
      <div className="text-2xs uppercase tracking-wider text-ink-faint mb-2 select-none">
        {title}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-2xs text-ink-dim select-none">{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-1">{children}</div>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
  allowNone = true,
}: {
  value: string | null;
  options: Array<{ v: string; label?: string }>;
  onChange: (v: string | null) => void;
  allowNone?: boolean;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.currentTarget.value || null)}
      className="flex-1 min-w-0 bg-surface-2 border border-line rounded px-1.5 py-1 text-2xs text-ink focus:outline-none focus:border-accent appearance-none"
    >
      {allowNone && <option value="">—</option>}
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label ?? o.v}
        </option>
      ))}
    </select>
  );
}

/** Text input that commits on Enter/blur only (undo stays coarse-grained). */
function CommitInput({
  value,
  onCommit,
  placeholder,
  width = "flex-1",
  mono = true,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  width?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
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
      className={`${width} min-w-0 bg-surface-2 border border-line rounded px-1.5 py-1 text-2xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent ${mono ? "font-mono" : ""}`}
    />
  );
}

// --- sections ---------------------------------------------------------------

function LayoutSection({ tokens, commit }: SectionProps) {
  const display = readKnob(tokens, KNOBS.display);
  const isFlex = display === "flex" || display === "inline-flex";
  return (
    <Section title="Layout">
      <Row label="Display">
        <Select
          value={display}
          onChange={(v) => commit(setKnob(tokens, KNOBS.display, v))}
          options={["block", "flex", "grid", "inline-block", "inline-flex", "inline-grid", "inline", "hidden"].map((v) => ({ v }))}
        />
      </Row>
      {isFlex && (
        <>
          <Row label="Direction">
            <Select
              value={readKnob(tokens, KNOBS.flexDirection)}
              onChange={(v) =>
                commit(setKnob(tokens, KNOBS.flexDirection, v && `flex-${v}`))
              }
              options={[
                { v: "row" },
                { v: "col", label: "column" },
                { v: "row-reverse" },
                { v: "col-reverse", label: "column-reverse" },
              ]}
            />
          </Row>
          <Row label="Justify">
            <Select
              value={readKnob(tokens, KNOBS.justify)}
              onChange={(v) => commit(setKnob(tokens, KNOBS.justify, v && `justify-${v}`))}
              options={["start", "center", "end", "between", "around", "evenly"].map((v) => ({ v }))}
            />
          </Row>
          <Row label="Align">
            <Select
              value={readKnob(tokens, KNOBS.items)}
              onChange={(v) => commit(setKnob(tokens, KNOBS.items, v && `items-${v}`))}
              options={["start", "center", "end", "baseline", "stretch"].map((v) => ({ v }))}
            />
          </Row>
          <Row label="Gap">
            <SteppableValue
              value={readKnob(tokens, KNOBS.gap)}
              onCommit={(v) => commit(setKnob(tokens, KNOBS.gap, v && `gap-${v}`))}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

/** Value input with scale steppers, for spacing-scale knobs. */
function SteppableValue({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
}) {
  return (
    <>
      <button
        onClick={() => onCommit(stepSpacing(value, -1))}
        className="w-5 h-6 shrink-0 rounded bg-surface-2 text-ink-dim hover:text-ink text-2xs"
      >
        −
      </button>
      <CommitInput
        value={value ?? ""}
        placeholder="—"
        onCommit={(v) => onCommit(v.trim() || null)}
      />
      <button
        onClick={() => onCommit(stepSpacing(value, 1))}
        className="w-5 h-6 shrink-0 rounded bg-surface-2 text-ink-dim hover:text-ink text-2xs"
      >
        +
      </button>
    </>
  );
}

function SpacingSection({ tokens, commit }: SectionProps) {
  return (
    <Section title="Spacing">
      <FourWay
        label="Padding"
        sides={readSpacing(tokens, "p")}
        onCommit={(s) => commit(writeSpacing(tokens, "p", s))}
      />
      <FourWay
        label="Margin"
        sides={readSpacing(tokens, "m")}
        onCommit={(s) => commit(writeSpacing(tokens, "m", s))}
      />
    </Section>
  );
}

/** Figma-style four-way input (T / R / B / L). */
function FourWay({
  label,
  sides,
  onCommit,
}: {
  label: string;
  sides: Sides;
  onCommit: (s: Sides) => void;
}) {
  const set = (k: keyof Sides, v: string) =>
    onCommit({ ...sides, [k]: v.trim() || null });
  const cell = (k: keyof Sides, title: string) => (
    <CommitInput
      value={sides[k] ?? ""}
      placeholder={title}
      onCommit={(v) => set(k, v)}
      width="w-full"
    />
  );
  return (
    <div>
      <div className="text-2xs text-ink-dim mb-1 select-none">{label}</div>
      <div className="grid grid-cols-4 gap-1">
        {cell("t", "T")}
        {cell("r", "R")}
        {cell("b", "B")}
        {cell("l", "L")}
      </div>
    </div>
  );
}

function SizeSection({ tokens, commit }: SectionProps) {
  const knob = (label: string, re: RegExp, prefix: string) => (
    <Row label={label}>
      <CommitInput
        value={readKnob(tokens, re) ?? ""}
        placeholder="—"
        onCommit={(v) =>
          commit(setKnob(tokens, re, v.trim() ? `${prefix}-${v.trim()}` : null))
        }
      />
    </Row>
  );
  return (
    <Section title="Size">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
        {knob("W", KNOBS.width, "w")}
        {knob("H", KNOBS.height, "h")}
        {knob("Min W", KNOBS.minWidth, "min-w")}
        {knob("Min H", KNOBS.minHeight, "min-h")}
        {knob("Max W", KNOBS.maxWidth, "max-w")}
        {knob("Max H", KNOBS.maxHeight, "max-h")}
      </div>
    </Section>
  );
}

function TypographySection({ tokens, commit }: SectionProps) {
  return (
    <Section title="Typography">
      <Row label="Size">
        <Select
          value={readKnob(tokens, KNOBS.fontSize)}
          onChange={(v) => commit(setKnob(tokens, KNOBS.fontSize, v && `text-${v}`))}
          options={FONT_SIZES.map((v) => ({ v }))}
        />
      </Row>
      <Row label="Weight">
        <Select
          value={readKnob(tokens, KNOBS.fontWeight)}
          onChange={(v) => commit(setKnob(tokens, KNOBS.fontWeight, v && `font-${v}`))}
          options={["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"].map((v) => ({ v }))}
        />
      </Row>
      <Row label="Align">
        <Select
          value={readKnob(tokens, KNOBS.textAlign)}
          onChange={(v) => commit(setKnob(tokens, KNOBS.textAlign, v && `text-${v}`))}
          options={["left", "center", "right", "justify"].map((v) => ({ v }))}
        />
      </Row>
      <Row label="Color">
        <CommitInput
          value={readKnob(tokens, KNOBS.textColor) ?? ""}
          placeholder="e.g. zinc-400"
          onCommit={(v) =>
            commit(setKnob(tokens, KNOBS.textColor, v.trim() ? `text-${v.trim()}` : null))
          }
        />
      </Row>
    </Section>
  );
}

function FillSection({ tokens, commit }: SectionProps) {
  const borderW = readKnob(tokens, KNOBS.borderWidth);
  return (
    <Section title="Fill & Border">
      <Row label="Fill">
        <CommitInput
          value={readKnob(tokens, KNOBS.background) ?? ""}
          placeholder="e.g. white, zinc-900"
          onCommit={(v) =>
            commit(setKnob(tokens, KNOBS.background, v.trim() ? `bg-${v.trim()}` : null))
          }
        />
      </Row>
      <Row label="Border">
        <Select
          value={borderW === null ? null : borderW.startsWith("border") ? "1" : borderW}
          onChange={(v) =>
            commit(setKnob(tokens, KNOBS.borderWidth, v === null ? null : v === "1" ? "border" : `border-${v}`))
          }
          options={[{ v: "0" }, { v: "1" }, { v: "2" }, { v: "4" }, { v: "8" }]}
        />
        <CommitInput
          value={readKnob(tokens, KNOBS.borderColor) ?? ""}
          placeholder="color"
          onCommit={(v) =>
            commit(setKnob(tokens, KNOBS.borderColor, v.trim() ? `border-${v.trim()}` : null))
          }
        />
      </Row>
      <Row label="Radius">
        <Select
          value={readKnob(tokens, KNOBS.radius) ?? (tokens.includes("rounded") ? "rounded" : null)}
          onChange={(v) =>
            commit(setKnob(tokens, KNOBS.radius, v === null ? null : v === "rounded" ? "rounded" : `rounded-${v}`))
          }
          options={[
            { v: "none" },
            { v: "sm" },
            { v: "rounded", label: "default" },
            { v: "md" },
            { v: "lg" },
            { v: "xl" },
            { v: "2xl" },
            { v: "3xl" },
            { v: "full" },
          ]}
        />
      </Row>
      <Row label="Shadow">
        <Select
          value={readKnob(tokens, KNOBS.shadow) ?? (tokens.includes("shadow") ? "shadow" : null)}
          onChange={(v) =>
            commit(setKnob(tokens, KNOBS.shadow, v === null ? null : v === "shadow" ? "shadow" : `shadow-${v}`))
          }
          options={[
            { v: "none" },
            { v: "sm" },
            { v: "shadow", label: "default" },
            { v: "md" },
            { v: "lg" },
            { v: "xl" },
            { v: "2xl" },
            { v: "inner" },
          ]}
        />
      </Row>
    </Section>
  );
}

/** The raw class list — the escape hatch (FR-3.6). */
function ClassesField({
  className,
  onCommit,
}: {
  className: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(className);
  useEffect(() => setDraft(className), [className]);
  return (
    <div className="px-3 py-3 border-b border-line">
      <div className="text-2xs uppercase tracking-wider text-ink-faint mb-2 select-none">
        Classes
      </div>
      <textarea
        value={draft}
        spellCheck={false}
        rows={3}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => draft !== className && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(className);
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
        className="w-full resize-y bg-surface-2 border border-line rounded px-2 py-1.5 text-2xs font-mono text-ink leading-relaxed focus:outline-none focus:border-accent"
      />
    </div>
  );
}
