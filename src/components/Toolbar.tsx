// Floating canvas toolbar (FR-6.1), Figma-style: tools bottom-center, with
// the zoom controls that used to live in the TopBar.
import { useStore } from "../lib/store";
import { BrowseIcon, CursorIcon, HandIcon } from "./icons";

const TOOLS = [
  {
    id: "select" as const,
    icon: CursorIcon,
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
    id: "browse" as const,
    icon: BrowseIcon,
    label: "Browse",
    hint: "Browse — clicks reach your app so you can navigate it (B)",
  },
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 rounded-xl border border-line bg-surface-1/95 backdrop-blur px-1.5 py-1 shadow-2xl select-none">
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const active = tool === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={t.hint}
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              active
                ? "bg-accent text-white"
                : "text-ink-dim hover:text-ink hover:bg-surface-2"
            }`}
          >
            <Icon size={15} />
          </button>
        );
      })}

      <div className="mx-1 h-5 w-px bg-line" />

      <button
        onClick={() => setZoom(zoom - 0.1)}
        className="h-8 w-7 rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2"
        title="Zoom out (⌘−scroll)"
      >
        −
      </button>
      <span className="w-10 text-center text-2xs tabular-nums text-ink-dim">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => setZoom(zoom + 0.1)}
        className="h-8 w-7 rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2"
        title="Zoom in (⌘+scroll)"
      >
        +
      </button>
    </div>
  );
}
