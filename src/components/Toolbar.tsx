// Floating canvas toolbar (FR-6.1), Figma-style: tools bottom-center, with
// the zoom controls that used to live in the TopBar.
import { useStore } from "../lib/store";
import { PALETTE, PALETTE_ORDER } from "../lib/palette";
import {
  BoxIcon,
  ButtonIcon,
  CursorArrowIcon,
  GlobeIcon,
  HandIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  TextAlignLeftIcon,
  TextIcon,
} from "@radix-ui/react-icons";
import type { IconType } from "./ui";

const PALETTE_ICONS: Record<string, IconType> = {
  div: BoxIcon,
  // A paragraph block, not a bare T: the T is the text *tool* (edit what is
  // already there), and this is the palette (place something new). Two
  // identical glyphs a few pixels apart would make them read as one control.
  text: TextAlignLeftIcon,
  button: ButtonIcon,
  image: ImageIcon,
};

const TOOLS = [
  {
    id: "select" as const,
    icon: CursorArrowIcon,
    label: "Select",
    hint: "Select — click an element to inspect it (V)",
  },
  {
    id: "hand" as const,
    icon: HandIcon,
    label: "Hand",
    hint: "Hand — drag to pan the canvas (H, or hold Space)",
  },
  {
    id: "text" as const,
    icon: TextIcon,
    label: "Text",
    hint: "Text — click text on the canvas to type into it (T). Double-clicking any text does the same.",
  },
  {
    id: "browse" as const,
    icon: GlobeIcon,
    label: "Browse",
    hint: "Browse — clicks reach your app so you can navigate it (B)",
  },
];

export function Toolbar() {
  const consoleOpen = useStore((s) => s.consoleOpen);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const textEditing = useStore((s) => s.textEditing);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const insertKind = useStore((s) => s.insertKind);
  const setInsertKind = useStore((s) => s.setInsertKind);

  return (
    <div
      // Sits above an open console rather than under it: the tools have to
      // stay reachable while the user is reading a build error.
      className={`panel absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 px-1.5 py-1 select-none transition-[bottom] duration-150 ${
        consoleOpen ? "bottom-[15rem]" : "bottom-4"
      }`}
    >
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const active = tool === t.id;
        // A caret actually blinking in the page is a stronger state than an
        // armed tool, and the user needs to be able to tell them apart: this
        // is why their typing is going into the artboard and not into a
        // shortcut.
        const typing = t.id === "text" && textEditing !== null;
        return (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={typing ? "Typing on the canvas — Enter commits, Esc reverts" : t.hint}
            className={`flex h-8 items-center justify-center gap-1 rounded-lg ${
              typing ? "w-auto px-2" : "w-8"
            } ${
              active
                ? "bg-accent text-white"
                : "text-ink-dim hover:text-ink hover:bg-surface-2"
            }`}
          >
            <Icon width={15} height={15} />
            {typing && <span className="text-2xs font-medium">Typing</span>}
          </button>
        );
      })}

      <div className="mx-1 h-5 w-px bg-line" />

      {/* Insert palette: arm a kind, then click where it goes on the canvas.
          Only in the select tool — the others own the click. */}
      {PALETTE_ORDER.map((kind) => {
        const Icon = PALETTE_ICONS[kind];
        const active = insertKind === kind;
        return (
          <button
            key={kind}
            onClick={() => {
              setTool("select");
              setInsertKind(active ? null : kind);
            }}
            title={`Insert ${PALETTE[kind].label} — then click where it goes`}
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              active
                ? "bg-accent text-white"
                : "text-ink-dim hover:text-ink hover:bg-surface-2"
            }`}
          >
            <Icon width={15} height={15} />
          </button>
        );
      })}

      <div className="mx-1 h-5 w-px bg-line" />

      <button
        onClick={() => setZoom(zoom - 0.1)}
        className="flex h-8 w-7 items-center justify-center rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2"
        title="Zoom out (⌘−scroll)"
      >
        <MinusIcon width={14} height={14} />
      </button>
      <span className="w-10 text-center text-2xs tabular-nums text-ink-dim">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => setZoom(zoom + 0.1)}
        className="flex h-8 w-7 items-center justify-center rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2"
        title="Zoom in (⌘+scroll)"
      >
        <PlusIcon width={14} height={14} />
      </button>
    </div>
  );
}
