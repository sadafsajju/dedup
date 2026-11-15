// Settings — opened from the menu bar (dedup → Settings…, ⌘,), or from the
// chat's "Open Settings" when no backend is on. App-wide: it covers the launch
// screen as readily as the editor, since an AI backend is chosen once for
// every project.
//
// A page with a section rail rather than a popover, because settings grow: a
// new section is a row in SECTIONS and a component, not a second surface.
import { useEffect } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import type { SettingsSection } from "../lib/store";
import { AiBackends } from "./AiSwitch";

const SECTIONS: { id: SettingsSection; label: string; hint: string }[] = [
  {
    id: "ai",
    label: "AI backends",
    hint: "The coding agents and API key dedup's AI features run on.",
  },
];

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const section = useStore((s) => s.settingsSection);
  const openSettings = useStore((s) => s.openSettings);
  const close = useStore((s) => s.closeSettings);

  // Escape closes — taken in the capture phase, so the editor's own Escape
  // (drop the tool, clear the selection) doesn't also fire underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open) return null;
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-[60] flex bg-surface-0 text-ink"
    >
      <nav className="w-52 shrink-0 border-r border-line bg-surface-1 px-2 pt-12 pb-4">
        <div id="settings-title" className="px-2 pb-3 text-sm font-medium">
          Settings
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => openSettings(s.id)}
            className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
              s.id === current.id ? "bg-surface-3 text-ink" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <button
          onClick={close}
          title="Close (Esc)"
          className="absolute right-4 top-4 rounded-md p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          <Cross2Icon width={14} height={14} />
        </button>
        <div className="mx-auto max-w-xl px-8 pt-12 pb-16">
          <h1 className="text-base font-medium">{current.label}</h1>
          <p className="mt-1 mb-5 text-xs text-ink-dim">{current.hint}</p>
          {current.id === "ai" && <AiBackends />}
        </div>
      </main>
    </div>
  );
}
