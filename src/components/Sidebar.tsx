import { PANEL_BOUNDS, useStore } from "../lib/store";
import type { SidebarTab } from "../lib/types";
import { isValueAction } from "../lib/types";
import {
  CommitIcon,
  FileTextIcon,
  LayersIcon,
} from "@radix-ui/react-icons";
import { CommitTab } from "./CommitTab";
import { LayersTab } from "./Layers";
import { PagesTab } from "./Pages";
import { ResizeHandle, type IconType } from "./ui";

const TABS: {
  id: SidebarTab;
  label: string;
  icon: IconType;
}[] = [
  { id: "pages", label: "Pages", icon: FileTextIcon },
  { id: "layers", label: "Layers", icon: LayersIcon },
  { id: "commit", label: "Commit", icon: CommitIcon },
];

export function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const width = useStore((s) => s.panelWidths.sidebar);
  const setPanelWidth = useStore((s) => s.setPanelWidth);
  // Something is waiting on a decision in the Commit tab: unsaved edits, or
  // an AI preview that is on disk and committed to nothing.
  const waiting = useStore(
    (s) =>
      s.pendingEdit !== null ||
      s.actions.some((a) => !isValueAction(a) || a.before !== a.after),
  );

  return (
    <aside
      style={{ width }}
      // Floats over the canvas, inset from the window edges — the chrome is a
      // layer above the work, not a wall beside it.
      className="panel absolute left-3 top-16 bottom-16 z-20 flex flex-col overflow-hidden"
    >
      <ResizeHandle
        side="right"
        label="Sidebar width"
        width={width}
        min={PANEL_BOUNDS.sidebar.min}
        max={PANEL_BOUNDS.sidebar.max}
        onResize={(px) => setPanelWidth("sidebar", px)}
        onReset={() => setPanelWidth("sidebar", PANEL_BOUNDS.sidebar.default)}
      />
      {/* Segmented control rather than underlined tabs: the panel already
          has an edge, and a second horizontal rule inside it reads as a
          seam. */}
      <div className="shrink-0 p-2">
        <div className="flex items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={t.label}
                className={`relative flex items-center justify-center gap-1.5 h-7 rounded-lg text-2xs transition-colors ${
                  tab === t.id ? "flex-[2]" : "flex-1"
                } ${
                  tab === t.id
                    ? "bg-surface-3 text-ink shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                <Icon width={13} height={13} className="shrink-0" />
                {/* Label on the active tab only: at the sidebar's real width
                    full labels can truncate, and the icon already
                    carries the identity. */}
                {tab === t.id && <span className="truncate">{t.label}</span>}
                {t.id === "commit" && waiting && (
                  <span
                    className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                    aria-label="Uncommitted changes"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "layers" ? (
        <LayersTab />
      ) : tab === "commit" ? (
        <CommitTab />
      ) : (
        <PagesTab />
      )}
    </aside>
  );
}
