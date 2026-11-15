// Reference-matched property rail, backed by the existing Tailwind edit model.
import { useEffect, useState } from "react";
import {
  PlusIcon,
  MinusIcon,
  Cross2Icon,
  LockClosedIcon,
  LockOpen1Icon,
  ChevronDownIcon,
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
  StretchVerticallyIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  WidthIcon,
} from "@radix-ui/react-icons";
import { ColorPicker, hexOf } from "./ColorPicker";
import { useStore } from "../lib/store";
import {
  fromTokens,
  KNOBS,
  mergeClasses,
  pageColor,
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
    <div className="reference-properties">
      <AlignmentToolbar tokens={tokens} commit={commit} />
      <ReferenceSection title="Template"><ClassesSection className={className} onCommit={applyClassEdit} /></ReferenceSection>
      <BreakpointSection tokens={tokens} commit={commit} />
      <ReferenceSection title="Layout"><LayoutSection tokens={tokens} commit={commit} /></ReferenceSection>
      <ReferenceSection title="Spacing"><SpacingSection tokens={tokens} commit={commit} /></ReferenceSection>
      <SizeSection tokens={tokens} commit={commit} />
      <BaseTypography tokens={tokens} commit={commit} />
      <ReferenceSection title="Overlays"><PropertyRow label="Z index"><Field title="z-*" value={readKnob(tokens, /^z-(.+)$/) ?? ""} onCommit={v => commit(setKnob(tokens, /^z-(.+)$/, v ? `z-${v}` : null))} /></PropertyRow></ReferenceSection>
      <ReferenceSection title="Cursor"><PropertyRow label="Type"><Select title="Cursor" value={readKnob(tokens, /^cursor-(.+)$/)} options={["auto", "default", "pointer", "text", "move", "grab", "not-allowed"].map(v => ({ v }))} onChange={v => commit(setKnob(tokens, /^cursor-(.+)$/, v && `cursor-${v}`))} /></PropertyRow></ReferenceSection>
      <ReferenceSection title="Effects"><StylesSection tokens={tokens} commit={commit} /></ReferenceSection>
      <ReferenceStyles tokens={tokens} commit={commit} />
    </div>
  );
}

interface SectionProps {
  tokens: Tokens;
  commit: (next: Tokens, group?: string) => void;
}

/** The whole heading is the hit target, not just the +: a title with a
 * disclosure next to it reads as one control, so aiming at the 18px icon is a
 * cost with nothing on the other side of it. */
function ReferenceSection({ title, children, right, open = false, fixed = false }: { title: string; children: React.ReactNode; right?: React.ReactNode; open?: boolean; fixed?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const heading = <><h3>{title}</h3>{!fixed && <span className="reference-disclosure">{expanded ? <MinusIcon width={14} height={14} /> : <PlusIcon width={14} height={14} />}</span>}</>;
  return <section className={`reference-section ${expanded ? "is-expanded" : ""}`}>
    {/* The action sits beside the toggle, never inside it — a button within a
        button is invalid markup and would swallow the header click. */}
    <div className="reference-heading-row">
      {fixed
        ? <div className="reference-heading">{heading}</div>
        : <button type="button" className="reference-heading" aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{heading}</button>}
      {right}
    </div>
    {expanded && <div className="reference-body">{children}</div>}
  </section>;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="reference-row"><span>{label}</span><div className="reference-values">{children}</div></div>;
}

function PixelField({ value, suffix, title, onCommit }: { value: string; suffix?: string; title: string; onCommit: (v: string) => void }) {
  return <div className="reference-pixel"><Field mono={false} title={title} value={value} onCommit={onCommit} />{suffix && <span>{suffix}</span>}</div>;
}

function pixelValue(value: string | null): string {
  if (value === null) return "";
  if (/^\[-?[\d.]+px\]$/.test(value)) return value.slice(1, -3);
  if (/^[\d.]+$/.test(value)) return String(Number(value) * 4);
  return value;
}

function BreakpointSection({ tokens, commit }: SectionProps) {
  const [locked, setLocked] = useState(false);
  const width = pixelValue(readKnob(tokens, KNOBS.width));
  const height = pixelValue(readKnob(tokens, KNOBS.height));
  const setDimension = (axis: "w" | "h", v: string) => {
    if (v && (!Number.isFinite(Number(v)) || Number(v) < 0)) return;
    let next = setKnob(tokens, axis === "w" ? KNOBS.width : KNOBS.height, v ? `${axis}-[${v}px]` : null);
    if (locked && Number(width) > 0 && Number(height) > 0 && v) {
      const other = Math.round(Number(v) * (axis === "w" ? Number(height) / Number(width) : Number(width) / Number(height)));
      next = setKnob(next, axis === "w" ? KNOBS.height : KNOBS.width, `${axis === "w" ? "h" : "w"}-[${other}px]`);
    }
    commit(next);
  };
  const dimension = (axis: "w" | "h", value: string) => {
    const mode = ["auto", "full", "fit", "min", "max"].includes(value) ? value : value ? "fixed" : "auto";
    return <><PixelField title={axis === "w" ? "Width in pixels" : "Height in pixels"} value={mode === "fixed" ? value : ""} onCommit={v => setDimension(axis, v)} /><div className="reference-select"><select aria-label={`${axis === "w" ? "Width" : "Height"} sizing`} value={mode} onChange={e => { const v = e.target.value; commit(setKnob(tokens, axis === "w" ? KNOBS.width : KNOBS.height, `${axis}-${v === "fixed" ? "[100px]" : v}`)); }}><option value="fixed">Fixed</option><option value="auto">Auto</option><option value="full">Fill</option><option value="fit">Fit</option><option value="min">Min</option><option value="max">Max</option></select><ChevronDownIcon /></div></>;
  };
  return <ReferenceSection title="Breakpoint" open fixed>
    <PropertyRow label="Position">{(["left", "top"] as const).map((axis, i) => <PixelField key={axis} title={`${axis} offset in pixels`} suffix={i ? "Y" : "X"} value={pixelValue(readKnob(tokens, new RegExp(`^${axis}-(.+)$`))) || "0"} onCommit={v => { if (!Number.isFinite(Number(v))) return; let next = setKnob(tokens, new RegExp(`^${axis}-(.+)$`), v ? `${axis}-[${v}px]` : null); if (v && !readKnob(tokens, /^(relative|absolute|fixed|sticky)$/)) next = setKnob(next, /^(static|relative|absolute|fixed|sticky)$/, "relative"); commit(next); }} />)}</PropertyRow>
    <div className="reference-dimensions"><PropertyRow label="Width">{dimension("w", width)}</PropertyRow><button className="reference-lock" type="button" aria-label="Lock aspect ratio" aria-pressed={locked} onClick={() => setLocked(!locked)}>{locked ? <LockClosedIcon /> : <LockOpen1Icon />}</button><PropertyRow label="Height">{dimension("h", height)}</PropertyRow></div>
  </ReferenceSection>;
}

function BaseTypography({ tokens, commit }: SectionProps) {
  const raw = readKnob(tokens, KNOBS.fontSize);
  const sizes: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36, "5xl": 48, "6xl": 60, "7xl": 72, "8xl": 96, "9xl": 128 };
  const value = raw ? String(sizes[raw] ?? pixelValue(raw)) : "";
  const update = (v: string) => { if (!v) commit(setKnob(tokens, KNOBS.fontSize, null)); else if (Number.isFinite(Number(v)) && Number(v) > 0) commit(setKnob(tokens, KNOBS.fontSize, `text-[${v}px]`)); };
  return <><ReferenceSection title="Typography" open fixed><PropertyRow label="Base"><PixelField title="Font size in pixels" value={value} suffix="PX" onCommit={update} /><div className="reference-stepper"><button aria-label="Decrease font size" onClick={() => update(String(Math.max(1, (Number(value) || 16) - 1)))}><MinusIcon /></button><span /><button aria-label="Increase font size" onClick={() => update(String((Number(value) || 16) + 1))}><PlusIcon /></button></div></PropertyRow></ReferenceSection>
    {/* A peer section, not a fold inside Typography: one flat list of
        sections is what makes the panel scannable. */}
    <ReferenceSection title="More typography"><TypographySection tokens={tokens} commit={commit} /></ReferenceSection></>;
}

function ReferenceStyles({ tokens, commit }: SectionProps) {
  const fill = readKnob(tokens, KNOBS.background);
  const selected = useStore((s) => s.selected);
  // A project token (`primary`) is a name only the page can resolve; show the
  // colour it resolved to, and keep the name in the tooltip and under Effects.
  const painted = pageColor(fill, "bg", selected);
  const display = fill?.match(/^\[#([a-fA-F0-9]+)\]$/)?.[1]?.toUpperCase() ?? (fill === "white" ? "FFFFFF" : fill === "black" ? "000000" : (painted && hexOf(painted)) || (fill ?? ""));
  return <ReferenceSection title="Styles" open><PropertyRow label="Fill"><div className="reference-fill has-color-picker" title={fill ? `bg-${fill}` : undefined}><ColorPicker value={fill} css={painted} onChange={(hex, group) => commit(setKnob(tokens, KNOBS.background, `bg-[${hex}]`), group)} /><Field mono={false} title="Fill color" value={display} onCommit={v => commit(setKnob(tokens, KNOBS.background, v ? `bg-${/^[a-fA-F0-9]{3,8}$/.test(v) ? `[#${v}]` : v}` : null))} /><button aria-label="Remove fill" onClick={() => commit(setKnob(tokens, KNOBS.background, null))}><Cross2Icon /></button></div></PropertyRow><PropertyRow label="Overflow"><Select title="Overflow" value={readKnob(tokens, /^overflow-(visible|hidden|clip|scroll|auto)$/)} options={["visible", "hidden", "clip", "scroll", "auto"].map(v => ({ v, label: v[0].toUpperCase() + v.slice(1) }))} onChange={v => commit(setKnob(tokens, /^overflow-(visible|hidden|clip|scroll|auto)$/, v && `overflow-${v}`))} /></PropertyRow></ReferenceSection>;
}

type Axis = "row" | "col";

const DIRECTIONS: Array<{ v: string; icon: IconType; title: string }> = [
  { v: "row", icon: ArrowRightIcon, title: "flex-row" },
  { v: "col", icon: ArrowDownIcon, title: "flex-col" },
  { v: "row-reverse", icon: ArrowLeftIcon, title: "flex-row-reverse" },
  { v: "col-reverse", icon: ArrowUpIcon, title: "flex-col-reverse" },
];

/** The reference keeps the most common alignment actions in a quiet icon-only
 * rail above the property sections. They are still literal Tailwind controls:
 * the tooltip names the utility each button writes and the active value is
 * read from the same token model as the expanded Layout section. */
function AlignmentToolbar({ tokens, commit }: SectionProps) {
  const justify = readKnob(tokens, KNOBS.justify);
  const items = readKnob(tokens, KNOBS.items);
  const button = (
    value: string,
    current: string | null,
    icon: IconType,
    knob: RegExp,
    prefix: "justify" | "items",
  ) => {
    const glyph = ([AlignLeftIcon, AlignCenterHorizontallyIcon, AlignRightIcon, AlignTopIcon, AlignCenterVerticallyIcon, AlignBottomIcon, SpaceBetweenHorizontallyIcon, StretchVerticallyIcon] as IconType[]).indexOf(icon);
    const active = current === value;
    const utility = `${prefix}-${value}`;
    return (
      <button
        key={utility}
        type="button"
        aria-label={utility}
        title={utility}
        onClick={() => commit(setKnob(tokens, knob, active ? null : utility))}
        className={`inspector-alignment-button ${active ? "is-active" : ""}`}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
          {glyph < 3 ? <><path d={`M${[2, 9, 16][glyph]} 1V17`} /><rect x={glyph === 0 ? 5 : glyph === 1 ? 3 : 3} y="6.5" width={glyph === 1 ? 12 : 10} height="5" rx="1.5" fill="#303030" /></> : glyph < 6 ? <><path d={`M1 ${[2, 9, 16][glyph - 3]}H17`} /><rect x="6.5" y={glyph === 3 ? 5 : glyph === 4 ? 3 : 3} width="5" height={glyph === 4 ? 12 : 10} rx="1.5" fill="#303030" /></> : glyph === 6 ? <><path d="M3 1V17M15 1V17" /><rect x="6.5" y="4" width="5" height="10" rx="1.5" fill="#303030" /></> : <><path d="M1 3H17M1 15H17" /><rect x="4" y="6.5" width="10" height="5" rx="1.5" fill="#303030" /></>}
        </svg>
      </button>
    );
  };

  return (
    <div className="inspector-alignment-toolbar" aria-label="Alignment">
      <div className="inspector-alignment-group">
        {button("start", justify, AlignLeftIcon, KNOBS.justify, "justify")}
        {button("center", justify, AlignCenterHorizontallyIcon, KNOBS.justify, "justify")}
        {button("end", justify, AlignRightIcon, KNOBS.justify, "justify")}
      </div>
      <span className="inspector-alignment-divider" />
      <div className="inspector-alignment-group">
        {button("start", items, AlignTopIcon, KNOBS.items, "items")}
        {button("center", items, AlignCenterVerticallyIcon, KNOBS.items, "items")}
        {button("end", items, AlignBottomIcon, KNOBS.items, "items")}
      </div>
      <span className="inspector-alignment-divider" />
      <div className="inspector-alignment-group">
        {button("between", justify, SpaceBetweenHorizontallyIcon, KNOBS.justify, "justify")}
        {button("stretch", items, StretchVerticallyIcon, KNOBS.items, "items")}
      </div>
    </div>
  );
}

function LayoutSection({ tokens, commit }: SectionProps) {
  const display = readKnob(tokens, KNOBS.display);
  const isFlex = display === "flex" || display === "inline-flex";
  const direction = readKnob(tokens, KNOBS.flexDirection);
  const axis: Axis = direction?.startsWith("col") ? "col" : "row";

  return (
    <div className="reference-group">
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
    </div>
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
    <div className="reference-group">
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
    </div>
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
  // The one section that keeps a header action of its own (FR-3.4's min/max
  // constraints), which is why it names its own ReferenceSection.
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
    <ReferenceSection
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
      <div className="reference-group">
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
      </div>
    </ReferenceSection>
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
  const selected = useStore((s) => s.selected);
  return (
    <div className="reference-group">
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
            prefix={<Swatch value={color} css={pageColor(color, "text", selected)} />}
            title="text-* (colour)"
            value={color ?? ""}
            placeholder="zinc-400"
            onCommit={(v) =>
              commit(setKnob(tokens, KNOBS.textColor, v.trim() ? `text-${v.trim()}` : null))
            }
          />
        </Row>
      </Group>
    </div>
  );
}

function StylesSection({ tokens, commit }: SectionProps) {
  const borderW = readKnob(tokens, KNOBS.borderWidth);
  const fill = readKnob(tokens, KNOBS.background);
  const borderColor = readKnob(tokens, KNOBS.borderColor);
  const selected = useStore((s) => s.selected);
  return (
    <div className="reference-group">
      <Group label="Fill">
        <Row>
          <Field
            prefix={<Swatch value={fill} css={pageColor(fill, "bg", selected)} />}
            title="bg-*"
            value={fill ?? ""}
            placeholder="zinc-900"
            onCommit={(v) =>
              commit(setKnob(tokens, KNOBS.background, v.trim() ? `bg-${v.trim()}` : null))
            }
          />
        </Row>
      </Group>

      <Group label="Stroke">
        <Row>
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
          <Field
            prefix={<Swatch value={borderColor} css={pageColor(borderColor, "border", selected)} />}
            title="border-* (colour)"
            value={borderColor ?? ""}
            placeholder="colour"
            onCommit={(v) =>
              commit(
                setKnob(tokens, KNOBS.borderColor, v.trim() ? `border-${v.trim()}` : null),
              )
            }
          />
        </Row>
      </Group>

      <Group label="Appearance">
        <Row>
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
        </Row>
      </Group>
    </div>
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
    <div className="reference-group">
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
    </div>
  );
}
