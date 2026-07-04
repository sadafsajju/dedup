import { useMemo } from "react";
import { rankClusters, useStore } from "../lib/store";
import type { SidebarTab } from "../lib/types";
import { LayersIcon, PagesIcon, DuplicatesIcon } from "./icons";
import { DuplicatesTab } from "./Duplicates";

const TABS: {
  id: SidebarTab;
  label: string;
  icon: typeof LayersIcon;
}[] = [
  { id: "pages", label: "Pages", icon: PagesIcon },
  { id: "layers", label: "Layers", icon: LayersIcon },
  { id: "duplicates", label: "Duplicates", icon: DuplicatesIcon },
];

const PLACEHOLDER: Partial<Record<SidebarTab, string>> = {
  pages: "Phase 5",
  layers: "Phase 1",
};

export function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const scanResult = useStore((s) => s.scanResult);
  const dismissed = useStore((s) => s.dismissed);
  const clusterCount = useMemo(
    () => rankClusters(scanResult, dismissed).length,
    [scanResult, dismissed],
  );
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <aside className="w-56 shrink-0 flex flex-col border-r border-line bg-surface-1">
      <div className="flex border-b border-line">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative flex-1 flex flex-col items-center gap-1 py-2.5 text-2xs border-b-2 ${
                tab === t.id
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {t.label}
              {t.id === "duplicates" && clusterCount > 0 && (
                <span className="absolute top-1 right-2 rounded-full bg-accent px-1 text-[9px] leading-3 text-white tabular-nums">
                  {clusterCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "duplicates" ? (
        <DuplicatesTab />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <active.icon size={22} className="text-ink-faint mb-2" />
          <div className="text-2xs text-ink-dim">
            {active.label} tree lands in{" "}
            <span className="text-ink">{PLACEHOLDER[tab]}</span>.
          </div>
        </div>
      )}
    </aside>
  );
}
