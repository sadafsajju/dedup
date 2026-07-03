import { useState } from "react";
import { LayersIcon, PagesIcon, DuplicatesIcon } from "./icons";

type Tab = "pages" | "layers" | "duplicates";

const TABS: { id: Tab; label: string; icon: typeof LayersIcon; phase: string }[] =
  [
    { id: "pages", label: "Pages", icon: PagesIcon, phase: "Phase 3" },
    { id: "layers", label: "Layers", icon: LayersIcon, phase: "Phase 1" },
    {
      id: "duplicates",
      label: "Duplicates",
      icon: DuplicatesIcon,
      phase: "Phase 3",
    },
  ];

export function Sidebar() {
  const [tab, setTab] = useState<Tab>("layers");
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
              className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-2xs border-b-2 ${
                tab === t.id
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <active.icon size={22} className="text-ink-faint mb-2" />
        <div className="text-2xs text-ink-dim">
          {active.label} tree lands in{" "}
          <span className="text-ink">{active.phase}</span>.
        </div>
      </div>
    </aside>
  );
}
