// The Figma-style Tailwind controls (FR-3.2–3.6). Every control reads the
// effective class string, edits tokens through the mapping layer, and commits
// via applyClassEdit → staged + live canvas patch (FR-3.7).
//
// Presentation only. Layout follows Figma's UI3 right panel: bright section
// titles with their actions on the right, grey captions above each control
// group, 2-up fields. The sections themselves stay Tailwind's, not Figma's —
// there is no "Position"/"Rotation" to map onto utility classes.
import { useEffect, useState } from "react";
import {
  AlignBaselineIcon,
  AlignBottomIcon,
  AlignCenterHorizontallyIcon,
  AlignCenterVerticallyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BorderBottomIcon,
  BorderLeftIcon,
  BorderRightIcon,
  BorderSplitIcon,
  BorderTopIcon,
  BorderWidthIcon,
  BoxModelIcon,
  ColumnSpacingIcon,
  CornersIcon,
  DotsHorizontalIcon,
  FontBoldIcon,
  FontSizeIcon,
  HeightIcon,
  RowSpacingIcon,
  ShadowIcon,
  SpaceBetweenHorizontallyIcon,
  SpaceBetweenVerticallyIcon,
  SpaceEvenlyHorizontallyIcon,
  SpaceEvenlyVerticallyIcon,
  StretchHorizontallyIcon,
  StretchVerticallyIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  WidthIcon,
} from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import {
  fromTokens,
  KNOBS,
  mergeClasses,
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
import {
  Field,
  Group,
  IconButton,
  Row,
  Section,
  Select,
  Swatch,
  ToggleGroup,
  type IconType,
} from "./ui";

export function StylePanel({ className }: { className: string }) {
  const applyClassEdit = useStore((s) => s.applyClassEdit);
  const tokens = toTokens(className);
  const commit = (next: Tokens, group?: string) =>
    applyClassEdit(fromTokens(next), group);

  return (
    <>
      <LayoutSection tokens={tokens} commit={commit} />
      <SpacingSection tokens={tokens} commit={commit} />
      <SizeSection tokens={tokens} commit={commit} />
      <TypographySection tokens={tokens} commit={commit} />
      <FillSection tokens={tokens} commit={commit} />
      <ClassesSection className={className} onCommit={applyClassEdit} />
    </>
  );
}

interface SectionProps {
  tokens: Tokens;
  commit: (next: Tokens, group?: string) => void;
}

type Axis = "row" | "col";

/** Main-axis (justify-*) icons, flipped to match the flex direction. */
const MAIN_AXIS: Record<Axis, Array<{ v: string; icon: IconType }>> = {
  row: [
    { v: "start", icon: AlignLeftIcon },
    { v: "center", icon: AlignCenterHorizontallyIcon },
    { v: "end", icon: AlignRightIcon },
    { v: "between", icon: SpaceBetweenHorizontallyIcon },
    { v: "around", icon: ColumnSpacingIcon },
    { v: "evenly", icon: SpaceEvenlyHorizontallyIcon },
  ],
  col: [
    { v: "start", icon: AlignTopIcon },
    { v: "center", icon: AlignCenterVerticallyIcon },
    { v: "end", icon: AlignBottomIcon },
    { v: "between", icon: SpaceBetweenVerticallyIcon },
    { v: "around", icon: RowSpacingIcon },
    { v: "evenly", icon: SpaceEvenlyVerticallyIcon },
  ],
};

/** Cross-axis (items-*) icons — perpendicular to the main axis. */
const CROSS_AXIS: Record<Axis, Array<{ v: string; icon: IconType }>> = {
  row: [
    { v: "start", icon: AlignTopIcon },
    { v: "center", icon: AlignCenterVerticallyIcon },
    { v: "end", icon: AlignBottomIcon },
    { v: "baseline", icon: AlignBaselineIcon },
    { v: "stretch", icon: StretchVerticallyIcon },
  ],
  col: [
    { v: "start", icon: AlignLeftIcon },
    { v: "center", icon: AlignCenterHorizontallyIcon },
    { v: "end", icon: AlignRightIcon },
    { v: "baseline", icon: AlignBaselineIcon },
    { v: "stretch", icon: StretchHorizontallyIcon },
  ],
};

const DIRECTIONS: Array<{ v: string; icon: IconType; title: string }> = [
  { v: "row", icon: ArrowRightIcon, title: "flex-row" },
  { v: "col", icon: ArrowDownIcon, title: "flex-col" },
  { v: "row-reverse", icon: ArrowLeftIcon, title: "flex-row-reverse" },
  { v: "col-reverse", icon: ArrowUpIcon, title: "flex-col-reverse" },
];

function LayoutSection({ tokens, commit }: SectionProps) {
  const display = readKnob(tokens, KNOBS.display);
  const isFlex = display === "flex" || display === "inline-flex";
  const direction = readKnob(tokens, KNOBS.flexDirection);
  const axis: Axis = direction?.startsWith("col") ? "col" : "row";

  return (
    <Section title="Layout">
      <Group label="Display">
        <Row>
          <Select
            icon={BoxModelIcon}
            value={display}
            title="display"
            onChange={(v) => commit(setKnob(tokens, KNOBS.display, v))}
            options={[
              "block",
              "flex",
              "grid",
              "inline-block",
              "inline-flex",
              "inline-grid",
              "inline",
              "hidden",
            ].map((v) => ({ v }))}
          />
        </Row>
      </Group>

      {isFlex && (
        <>
          <Group label="Direction">
            <Row>
              <ToggleGroup
                value={direction}
                options={DIRECTIONS}
                onChange={(v) =>
                  commit(setKnob(tokens, KNOBS.flexDirection, v && `flex-${v}`))
                }
              />
            </Row>
          </Group>

          <Group label="Alignment">
            <Row>
              <ToggleGroup
                value={readKnob(tokens, KNOBS.justify)}
                options={MAIN_AXIS[axis].map((o) => ({
                  ...o,
                  title: `justify-${o.v}`,
                }))}
                onChange={(v) =>
                  commit(setKnob(tokens, KNOBS.justify, v && `justify-${v}`))
                }
              />
            </Row>
            <Row>
              <ToggleGroup
                value={readKnob(tokens, KNOBS.items)}
                options={CROSS_AXIS[axis].map((o) => ({
                  ...o,
                  title: `items-${o.v}`,
                }))}
                onChange={(v) =>
                  commit(setKnob(tokens, KNOBS.items, v && `items-${v}`))
                }
              />
            </Row>
          </Group>

          <Group label="Gap">
            <Row>
              <ScaleField
                icon={axis === "col" ? RowSpacingIcon : ColumnSpacingIcon}
                title="gap-* — drag the icon to step the spacing scale"
                value={readKnob(tokens, KNOBS.gap)}
                onCommit={(v, group) =>
                  commit(setKnob(tokens, KNOBS.gap, v && `gap-${v}`), group)
                }
              />
              <span className="flex-1" />
            </Row>
          </Group>
        </>
      )}
    </Section>
  );
}

/** Field bound to Tailwind's spacing scale, with drag-to-scrub on the icon. */
function ScaleField({
  icon,
  value,
  onCommit,
  title,
}: {
  icon: IconType;
  value: string | null;
  onCommit: (v: string | null, group?: string) => void;
  title?: string;
}) {
  return (
    <Field
      icon={icon}
      title={title}
      value={value ?? ""}
      onCommit={(v) => onCommit(v.trim() || null)}
      onScrub={(dir, group) => onCommit(stepSpacing(value, dir), group)}
    />
  );
}

function SpacingSection({ tokens, commit }: SectionProps) {
  return (
    <Section title="Spacing">
      <SpacingControl
        label="Padding"
        prefix="p"
        sides={readSpacing(tokens, "p")}
        onCommit={(s, group) => commit(writeSpacing(tokens, "p", s), group)}
      />
      <SpacingControl
        label="Margin"
        prefix="m"
        sides={readSpacing(tokens, "m")}
        onCommit={(s, group) => commit(writeSpacing(tokens, "m", s), group)}
      />
    </Section>
  );
}

/** Figma's padding control: axis pair by default, four sides when split.
 * Per-side values that can't be expressed as a pair force the split open. */
function SpacingControl({
  label,
  prefix,
  sides,
  onCommit,
}: {
  label: string;
  prefix: "p" | "m";
  sides: Sides;
  onCommit: (s: Sides, group?: string) => void;
}) {
  const [split, setSplit] = useState(false);
  const paired = sides.t === sides.b && sides.l === sides.r;
  const open = split || !paired;

  const setSides = (patch: Partial<Sides>, group?: string) =>
    onCommit({ ...sides, ...patch }, group);
  const side = (k: keyof Sides, sideIcon: IconType, suffix: string) => (
    <Field
      icon={sideIcon}
      title={`${prefix}${suffix}-*`}
      value={sides[k] ?? ""}
      onCommit={(v) => setSides({ [k]: v.trim() || null })}
      onScrub={(dir, group) => setSides({ [k]: stepSpacing(sides[k], dir) }, group)}
    />
  );

  return (
    <Group
      label={label}
      right={
        <IconButton
          icon={BorderSplitIcon}
          active={open}
          title={
            paired
              ? "Split into four sides"
              : "Per-side values — can't collapse to an axis pair"
          }
          onClick={() => paired && setSplit((v) => !v)}
        />
      }
    >
      {open ? (
        <div className="grid grid-cols-2 gap-2">
          {side("t", BorderTopIcon, "t")}
          {side("r", BorderRightIcon, "r")}
          {side("b", BorderBottomIcon, "b")}
          {side("l", BorderLeftIcon, "l")}
        </div>
      ) : (
        <Row>
          <Field
            icon={ColumnSpacingIcon}
            title={`${prefix}x-*`}
            value={sides.l ?? ""}
            onCommit={(v) => setSides({ l: v.trim() || null, r: v.trim() || null })}
            onScrub={(dir, group) => {
              const next = stepSpacing(sides.l, dir);
              setSides({ l: next, r: next }, group);
            }}
          />
          <Field
            icon={RowSpacingIcon}
            title={`${prefix}y-*`}
            value={sides.t ?? ""}
            onCommit={(v) => setSides({ t: v.trim() || null, b: v.trim() || null })}
            onScrub={(dir, group) => {
              const next = stepSpacing(sides.t, dir);
              setSides({ t: next, b: next }, group);
            }}
          />
        </Row>
      )}
    </Group>
  );
}

function SizeSection({ tokens, commit }: SectionProps) {
  const [bounds, setBounds] = useState(false);
  const field = (re: RegExp, prefixClass: string, fieldIcon: IconType) => (
    <Field
      icon={fieldIcon}
      title={`${prefixClass}-*`}
      value={readKnob(tokens, re) ?? ""}
      onCommit={(v) =>
        commit(setKnob(tokens, re, v.trim() ? `${prefixClass}-${v.trim()}` : null))
      }
      onScrub={(dir, group) => {
        const next = stepSpacing(readKnob(tokens, re), dir);
        commit(setKnob(tokens, re, `${prefixClass}-${next}`), group);
      }}
    />
  );
  return (
    <Section
      title="Size"
      right={
        <IconButton
          icon={DotsHorizontalIcon}
          active={bounds}
          title="Min / max constraints"
          onClick={() => setBounds((v) => !v)}
        />
      }
    >
      <Group label="Dimensions">
        <Row>
          {field(KNOBS.width, "w", WidthIcon)}
          {field(KNOBS.height, "h", HeightIcon)}
        </Row>
      </Group>
      {bounds && (
        <>
          <Group label="Minimum">
            <Row>
              {field(KNOBS.minWidth, "min-w", WidthIcon)}
              {field(KNOBS.minHeight, "min-h", HeightIcon)}
            </Row>
          </Group>
          <Group label="Maximum">
            <Row>
              {field(KNOBS.maxWidth, "max-w", WidthIcon)}
              {field(KNOBS.maxHeight, "max-h", HeightIcon)}
            </Row>
          </Group>
        </>
      )}
    </Section>
  );
}

const TEXT_ALIGN: Array<{ v: string; icon: IconType; title: string }> = [
  { v: "left", icon: TextAlignLeftIcon, title: "text-left" },
  { v: "center", icon: TextAlignCenterIcon, title: "text-center" },
  { v: "right", icon: TextAlignRightIcon, title: "text-right" },
  { v: "justify", icon: TextAlignJustifyIcon, title: "text-justify" },
];

function TypographySection({ tokens, commit }: SectionProps) {
  const color = readKnob(tokens, KNOBS.textColor);
  return (
    <Section title="Type">
      <Row>
        <Group label="Size">
          <Select
            icon={FontSizeIcon}
            title="text-* (size)"
            value={readKnob(tokens, KNOBS.fontSize)}
            onChange={(v) => commit(setKnob(tokens, KNOBS.fontSize, v && `text-${v}`))}
            options={FONT_SIZES.map((v) => ({ v }))}
          />
        </Group>
        <Group label="Weight">
          <Select
            icon={FontBoldIcon}
            title="font-* (weight)"
            value={readKnob(tokens, KNOBS.fontWeight)}
            onChange={(v) =>
              commit(setKnob(tokens, KNOBS.fontWeight, v && `font-${v}`))
            }
            options={[
              "thin",
              "extralight",
              "light",
              "normal",
              "medium",
              "semibold",
              "bold",
              "extrabold",
              "black",
            ].map((v) => ({ v }))}
          />
        </Group>
      </Row>
      <Group label="Alignment">
        <Row>
          <ToggleGroup
            value={readKnob(tokens, KNOBS.textAlign)}
            options={TEXT_ALIGN}
            onChange={(v) => commit(setKnob(tokens, KNOBS.textAlign, v && `text-${v}`))}
          />
        </Row>
      </Group>
      <Group label="Colour">
        <Row>
          <Field
            prefix={<Swatch value={color} />}
            title="text-* (colour)"
            value={color ?? ""}
            placeholder="zinc-400"
            onCommit={(v) =>
              commit(setKnob(tokens, KNOBS.textColor, v.trim() ? `text-${v.trim()}` : null))
            }
          />
        </Row>
      </Group>
    </Section>
  );
}

function FillSection({ tokens, commit }: SectionProps) {
  const borderW = readKnob(tokens, KNOBS.borderWidth);
  const fill = readKnob(tokens, KNOBS.background);
  const borderColor = readKnob(tokens, KNOBS.borderColor);
  return (
    <>
      <Section title="Fill">
        <Row>
          <Field
            prefix={<Swatch value={fill} />}
            title="bg-*"
            value={fill ?? ""}
            placeholder="zinc-900"
            onCommit={(v) =>
              commit(setKnob(tokens, KNOBS.background, v.trim() ? `bg-${v.trim()}` : null))
            }
          />
        </Row>
      </Section>

      <Section title="Stroke">
        <Row>
          <Group label="Width">
            <Select
              icon={BorderWidthIcon}
              title="border / border-*"
              value={borderW === null ? null : borderW.startsWith("border") ? "1" : borderW}
              onChange={(v) =>
                commit(
                  setKnob(
                    tokens,
                    KNOBS.borderWidth,
                    v === null ? null : v === "1" ? "border" : `border-${v}`,
                  ),
                )
              }
              options={[{ v: "0" }, { v: "1" }, { v: "2" }, { v: "4" }, { v: "8" }]}
            />
          </Group>
          <Group label="Colour">
            <Field
              prefix={<Swatch value={borderColor} />}
              title="border-* (colour)"
              value={borderColor ?? ""}
              placeholder="colour"
              onCommit={(v) =>
                commit(
                  setKnob(tokens, KNOBS.borderColor, v.trim() ? `border-${v.trim()}` : null),
                )
              }
            />
          </Group>
        </Row>
      </Section>

      <Section title="Appearance">
        <Row>
          <Group label="Corner radius">
            <Select
              icon={CornersIcon}
              title="rounded-*"
              value={
                readKnob(tokens, KNOBS.radius) ??
                (tokens.includes("rounded") ? "rounded" : null)
              }
              onChange={(v) =>
                commit(
                  setKnob(
                    tokens,
                    KNOBS.radius,
                    v === null ? null : v === "rounded" ? "rounded" : `rounded-${v}`,
                  ),
                )
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
          </Group>
          <Group label="Shadow">
            <Select
              icon={ShadowIcon}
              title="shadow-*"
              value={
                readKnob(tokens, KNOBS.shadow) ??
                (tokens.includes("shadow") ? "shadow" : null)
              }
              onChange={(v) =>
                commit(
                  setKnob(
                    tokens,
                    KNOBS.shadow,
                    v === null ? null : v === "shadow" ? "shadow" : `shadow-${v}`,
                  ),
                )
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
          </Group>
        </Row>
      </Section>
    </>
  );
}

/** The raw class list — the escape hatch (FR-3.6). */
function ClassesSection({
  className,
  onCommit,
}: {
  className: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(className);
  useEffect(() => setDraft(className), [className]);
  // Conflicts the knobs can't see: two `p-*`, a stray `flex` under a `grid`.
  const tidied = mergeClasses(draft);
  const hasConflicts = tidied !== draft.trim().replace(/\s+/g, " ");
  return (
    <Section title="Classes">
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
        className="w-full resize-y rounded-md border border-transparent bg-surface-2 px-2 py-1.5 font-mono text-xs leading-relaxed text-ink outline-none hover:border-line-strong focus:border-accent"
      />
      {hasConflicts && (
        <button
          onClick={() => {
            setDraft(tidied);
            onCommit(tidied);
          }}
          title={tidied}
          className="mt-1 text-2xs text-ink-faint hover:text-accent"
        >
          Tidy — drop overridden classes
        </button>
      )}
    </Section>
  );
}
