// Export an artboard: the button on its label, the format menu, and the
// notice that says how it went.
//
// What gets exported is the page rendered at the artboard's real size by
// WebKit, off-screen (src-tauri/src/export.rs) — not a crop of the canvas, so
// zoom, panels and the window edge don't end up in the file. PDF is vector:
// real, selectable text.
import { useEffect, useRef, useState } from "react";
import { Cross2Icon, DownloadIcon } from "@radix-ui/react-icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";

const OPTIONS: { label: string; hint: string; format: "png" | "pdf"; scale?: number }[] = [
  { label: "PNG", hint: "1x — the page's own size", format: "png", scale: 1 },
  { label: "PNG @2x", hint: "retina — twice the pixels", format: "png", scale: 2 },
  { label: "PDF", hint: "vector, selectable text, one page", format: "pdf" },
];

/** The export button for one artboard's label, with its format menu. */
export function ArtboardExportButton({ route }: { route: string }) {
  const exportArtboard = useStore((s) => s.exportArtboard);
  const exporting = useStore((s) => s.exporting);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const busyHere = exporting === route;
  return (
    <span ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        disabled={!!exporting}
        title={busyHere ? "Exporting…" : "Export this artboard as an image or PDF"}
        className={`rounded p-0.5 text-ink-faint hover:text-ink hover:bg-surface-2 disabled:cursor-default ${
          busyHere || open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        } ${busyHere ? "animate-pulse text-accent" : ""}`}
      >
        <DownloadIcon width={11} height={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="panel absolute left-0 top-full mt-1 z-40 w-52 rounded-md py-1"
          onClick={(e) => e.stopPropagation()}
        >
          {OPTIONS.map((o) => (
            <button
              key={o.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void exportArtboard(route, o.format, o.scale);
              }}
              className="w-full flex items-baseline gap-2 px-2.5 py-1 text-left hover:bg-surface-2"
            >
              <span className="text-2xs text-ink w-14 shrink-0">{o.label}</span>
              <span className="text-2xs text-ink-faint truncate">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** How the last export went: where it landed (with Show in Finder), or why
 *  it didn't. Floats over the canvas until dismissed. */
export function ExportNotice() {
  const notice = useStore((s) => s.exportNotice);
  const exporting = useStore((s) => s.exporting);
  const dismiss = useStore((s) => s.dismissExportNotice);
  if (!notice && !exporting) return null;
  return (
    <div className="panel absolute top-3 left-1/2 -translate-x-1/2 z-30 flex max-w-[min(640px,90%)] items-center gap-2 rounded-lg px-3 py-1.5 text-2xs">
      {exporting && !notice ? (
        <span className="text-ink-dim animate-pulse">Exporting {exporting}… rendering the page at full size</span>
      ) : notice ? (
        <>
          <span className={`min-w-0 truncate ${notice.error ? "text-danger" : "text-ink"}`} title={notice.text}>
            {notice.text}
          </span>
          {notice.path && (
            <button
              onClick={() => void revealItemInDir(notice.path as string)}
              className="shrink-0 text-accent hover:underline"
            >
              Show in Finder
            </button>
          )}
          <button onClick={dismiss} title="Dismiss" className="shrink-0 text-ink-faint hover:text-ink">
            <Cross2Icon width={10} height={10} />
          </button>
        </>
      ) : null}
    </div>
  );
}
