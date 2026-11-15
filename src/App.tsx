import { useEffect } from "react";
import { useStore } from "./lib/store";
import { onOpenSettings } from "./lib/api";
import { LaunchScreen } from "./components/LaunchScreen";
import { Editor } from "./components/Editor";
import { Settings } from "./components/Settings";

export default function App() {
  const view = useStore((s) => s.view);

  // The menu bar's Settings… (⌘,). A native menu item, so it fires wherever
  // focus is — including inside a canvas iframe, which no keydown listener
  // in this window would hear.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let gone = false;
    void onOpenSettings(() => useStore.getState().openSettings()).then((fn) => {
      // StrictMode mounts effects twice; an unlisten that resolves after the
      // first cleanup must still be called, or the listener fires twice.
      if (gone) fn();
      else unlisten = fn;
    });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  return (
    <>
      {view === "launch" ? <LaunchScreen /> : <Editor />}
      <Settings />
    </>
  );
}
