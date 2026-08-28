import { useMemo } from "react";
import { PANEL_BOUNDS, rankClusters, useStore } from "../lib/store";
import type { SidebarTab } from "../lib/types";
import { CopyIcon, FileTextIcon, LayersIcon } from "@radix-ui/react-icons";
import { DuplicatesTab } from "./Duplicates";
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
  { id: "duplicates", label: "Duplicates", icon: CopyIcon },
];

export function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const scanResult = useStore((s) => s.scanResult);
  const dismissed = useStore((s) => s.dismissed);
  const clusterCount = useMemo(
    () => rankClusters(scanResult, dismissed).length,
    [scanResult, dismissed],
  );
  const width = useStore((s) => s.panelWidths.sidebar);
  const setPanelWidth = useStore((s) => s.setPanelWidth);

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
                    three full labels truncate to noise, and the icon already
                    carries the identity. */}
                {tab === t.id && <span className="truncate">{t.label}</span>}
                {t.id === "duplicates" && clusterCount > 0 && (
                  <span className="rounded-full bg-accent px-1 text-[9px] leading-3 text-white tabular-nums">
                    {clusterCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "duplicates" ? (
        <DuplicatesTab />
      ) : tab === "layers" ? (
        <LayersTab />
      ) : (
        <PagesTab />
      )}
    </aside>
  );
}
