import { useEffect, useRef, useState } from "react";
import { onScaffoldLog, scaffoldProject } from "../lib/api";
import type { ProjectInfo, StarterKind } from "../lib/types";
import {
  CodeIcon,
  ComponentInstanceIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";

interface Props {
  info: ProjectInfo;
  onCancel: () => void;
  onCreated: (info: ProjectInfo) => void;
}

interface Starter {
  kind: StarterKind;
  title: string;
  stack: string;
  blurb: string;
  note: string;
  icon: React.ReactNode;
}

/**
 * The two things dedup can open, offered as the two things it can create.
 * The note under each is the honest cost of choosing it — one needs the
 * network and a minute, the other is on screen immediately.
 */
const STARTERS: Starter[] = [
  {
    kind: "react",
    title: "React app",
    stack: "Vite · TypeScript · Tailwind v4",
    blurb:
      "The full editor: component inspection, Tailwind styling, and source edits.",
    note: "Installs dependencies — needs a minute and a network connection.",
    icon: <ComponentInstanceIcon width={17} height={17} />,
  },
  {
    kind: "html",
    title: "HTML page",
    stack: "index.html · style.css · Tailwind CDN",
    blurb:
      "One page dedup serves itself. Click anything on the canvas and the edit is written straight back into the HTML.",
    note: "Nothing to install — it opens immediately, online or not.",
    icon: <CodeIcon width={17} height={17} />,
  },
];

/**
 * What an empty folder gets instead of a compatibility verdict.
 *
 * "Unsupported — no package.json" is a true statement about an empty folder
 * and a useless one: there is nothing wrong with it, it just isn't a project
 * yet. This asks the only question worth asking.
 */
export function StarterPicker({ info, onCancel, onCreated }: Props) {
  const [busy, setBusy] = useState<StarterKind | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onScaffoldLog((line) => setLines((prev) => [...prev.slice(-200), line]))
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  async function create(kind: StarterKind) {
    setBusy(kind);
    setError(null);
    setLines([]);
    try {
      onCreated(await scaffoldProject(info.root, kind));
    } catch (e) {
      // The files may well be on disk — the message says what to do next
      // rather than pretending nothing happened.
      setError(String(e));
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-8">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface-1 shadow-2xl">
        <div className="px-5 pt-5 pb-3">
          <div className="text-[15px] font-semibold">{info.name} is empty</div>
          <div className="text-2xs text-ink-faint font-mono truncate">
            {info.root}
          </div>
          <p className="text-[13px] text-ink-dim mt-2.5">
            Start something here. dedup writes the files, makes the folder a git
            repository, and commits the starter as its first commit — so every
            edit you make afterwards has a clean baseline behind it.
          </p>
        </div>

        <ul className="border-t border-line">
          {STARTERS.map((s) => (
            <li key={s.kind} className="border-b border-line last:border-b-0">
              <button
                onClick={() => create(s.kind)}
                disabled={busy !== null}
                className="w-full text-left px-5 py-4 flex gap-3.5 hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
              >
                <span className="mt-0.5 shrink-0 text-ink-dim">{s.icon}</span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium">{s.title}</span>
                    <span className="text-2xs text-ink-faint font-mono truncate">
                      {s.stack}
                    </span>
                  </span>
                  <span className="block text-2xs text-ink-dim mt-1 leading-snug">
                    {s.blurb}
                  </span>
                  <span className="block text-2xs text-ink-faint mt-1">
                    {busy === s.kind ? "Creating…" : s.note}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {lines.length > 0 && (
          <div
            ref={logRef}
            className="border-t border-line max-h-32 overflow-y-auto bg-surface-0 px-5 py-2.5"
          >
            {lines.map((line, i) => (
              <div
                key={i}
                className="text-2xs font-mono text-ink-faint whitespace-pre-wrap break-all leading-relaxed"
              >
                {line}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="border-t border-line px-5 py-3 flex gap-2">
            <ExclamationTriangleIcon
              width={13}
              height={13}
              className="text-danger shrink-0 mt-px"
            />
            <span className="text-2xs text-ink-dim leading-snug">{error}</span>
          </div>
        )}

        <div className="flex justify-end px-5 py-4 border-t border-line">
          <button
            onClick={onCancel}
            disabled={busy !== null}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
